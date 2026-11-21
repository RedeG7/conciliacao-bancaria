import { useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { Plus, Search, Shield, User, Lock, LockOpen, Trash2, Loader2, UserCog, UserCircle, Pencil } from "lucide-react";

interface AppUser {
  id: number;
  username: string;
  name: string;
  email: string | null;
  cpfCnpj: string | null;
  role: string;
  isActive: boolean;
  createdAt: string;
}

interface UserForm {
  username: string;
  password: string;
  name: string;
  email: string;
  cpfCnpj: string;
  role: string;
}

interface ProfileForm {
  name: string;
  email: string;
  cpfCnpj: string;
  password: string;
  confirmPassword: string;
}

function formatCpfCnpj(value: string) {
  const digits = value.replace(/\D/g, "");
  if (digits.length <= 11) {
    return digits
      .replace(/(\d{3})(\d)/, "$1.$2")
      .replace(/(\d{3})(\d)/, "$1.$2")
      .replace(/(\d{3})(\d{1,2})$/, "$1-$2");
  }
  return digits
    .replace(/^(\d{2})(\d)/, "$1.$2")
    .replace(/^(\d{2})\.(\d{3})(\d)/, "$1.$2.$3")
    .replace(/\.(\d{3})(\d)/, ".$1/$2")
    .replace(/(\d{4})(\d)/, "$1-$2")
    .slice(0, 18);
}

async function apiFetch(path: string, opts: RequestInit = {}) {
  const res = await fetch(path, { credentials: "include", ...opts });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return res.status === 204 ? null : res.json();
}

export default function UsuariosPage() {
  const { role, userId } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const isSuperAdmin = role === "super_admin";

  // ── Admin state ──
  const [showCreate, setShowCreate] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<AppUser | null>(null);
  const [editingUser, setEditingUser] = useState<AppUser | null>(null);
  const [cnpjLoading, setCnpjLoading] = useState(false);
  const [form, setForm] = useState<UserForm>({
    username: "", password: "", name: "", email: "", cpfCnpj: "", role: "user",
  });
  const [editForm, setEditForm] = useState({
    name: "", email: "", cpfCnpj: "", role: "user", newPassword: "", confirmPassword: "",
  });

  // ── Profile (own) state ──
  const [editingProfile, setEditingProfile] = useState(false);
  const [profileForm, setProfileForm] = useState<ProfileForm>({
    name: "", email: "", cpfCnpj: "", password: "", confirmPassword: "",
  });

  // ── Shared data fetching ──
  const { data: users = [], isLoading } = useQuery<AppUser[]>({
    queryKey: ["users"],
    queryFn: () => apiFetch("/api/users"),
  });

  // ── Admin mutations ──
  const createMutation = useMutation({
    mutationFn: (data: UserForm) =>
      apiFetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...data, cpfCnpj: data.cpfCnpj.replace(/\D/g, "") || undefined }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["users"] });
      setShowCreate(false);
      setForm({ username: "", password: "", name: "", email: "", cpfCnpj: "", role: "user" });
      toast({ description: "Usuário criado com sucesso." });
    },
    onError: (err: Error) => {
      toast({ title: "Erro", description: err.message, variant: "destructive" });
    },
  });

  const toggleActiveMutation = useMutation({
    mutationFn: ({ id, isActive }: { id: number; isActive: boolean }) =>
      apiFetch(`/api/users/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive }),
      }),
    onSuccess: (_data, { isActive }) => {
      queryClient.invalidateQueries({ queryKey: ["users"] });
      toast({ description: isActive ? "Acesso liberado." : "Acesso bloqueado." });
    },
    onError: (err: Error) => {
      toast({ title: "Erro", description: err.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/users/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["users"] });
      setDeleteTarget(null);
      toast({ description: "Usuário removido." });
    },
    onError: (err: Error) => {
      toast({ title: "Erro", description: err.message, variant: "destructive" });
    },
  });

  const editUserMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Record<string, any> }) =>
      apiFetch(`/api/users/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["users"] });
      setEditingUser(null);
      toast({ description: "Usuário atualizado com sucesso." });
    },
    onError: (err: Error) => {
      toast({ title: "Erro", description: err.message, variant: "destructive" });
    },
  });

  const handleOpenEditUser = (user: AppUser) => {
    setEditForm({
      name: user.name,
      email: user.email || "",
      cpfCnpj: user.cpfCnpj ? formatCpfCnpj(user.cpfCnpj) : "",
      role: user.role,
      newPassword: "",
      confirmPassword: "",
    });
    setEditingUser(user);
  };

  const handleEditUserSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingUser) return;
    if (editForm.newPassword && editForm.newPassword !== editForm.confirmPassword) {
      toast({ title: "Senhas não coincidem", description: "Confirme a nova senha corretamente.", variant: "destructive" });
      return;
    }
    if (editForm.newPassword && editForm.newPassword.length < 6) {
      toast({ title: "Senha muito curta", description: "A senha deve ter pelo menos 6 caracteres.", variant: "destructive" });
      return;
    }
    const data: Record<string, any> = {
      name: editForm.name,
      email: editForm.email || null,
      cpfCnpj: editForm.cpfCnpj.replace(/\D/g, "") || null,
      role: editForm.role,
    };
    if (editForm.newPassword) data.password = editForm.newPassword;
    editUserMutation.mutate({ id: editingUser.id, data });
  };

  // ── Profile mutation (own) ──
  const updateProfileMutation = useMutation({
    mutationFn: (data: Partial<ProfileForm>) => {
      const body: Record<string, string> = {};
      if (data.name) body.name = data.name;
      if (data.email !== undefined) body.email = data.email;
      if (data.cpfCnpj !== undefined) body.cpfCnpj = data.cpfCnpj.replace(/\D/g, "");
      if (data.password) body.password = data.password;
      return apiFetch(`/api/users/${userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["users"] });
      setEditingProfile(false);
      toast({ description: "Perfil atualizado com sucesso." });
    },
    onError: (err: Error) => {
      toast({ title: "Erro", description: err.message, variant: "destructive" });
    },
  });

  // ── Admin: CNPJ search ──
  const handleCnpjSearch = async () => {
    const digits = form.cpfCnpj.replace(/\D/g, "");
    if (digits.length !== 14) {
      toast({ title: "CNPJ inválido", description: "Informe os 14 dígitos do CNPJ.", variant: "destructive" });
      return;
    }
    setCnpjLoading(true);
    try {
      const data = await apiFetch(`/api/users/cnpj/${digits}`);
      setForm((f) => ({ ...f, name: data.razaoSocial || f.name, email: data.email || f.email }));
      toast({ description: `CNPJ encontrado: ${data.razaoSocial}` });
    } catch (err: any) {
      toast({ title: "Erro na consulta", description: err.message, variant: "destructive" });
    } finally {
      setCnpjLoading(false);
    }
  };

  const handleCreateSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.username || !form.password || !form.name) return;
    createMutation.mutate(form);
  };

  // ── Profile: open edit and pre-fill form ──
  const handleOpenEditProfile = (user: AppUser) => {
    setProfileForm({
      name: user.name,
      email: user.email || "",
      cpfCnpj: user.cpfCnpj ? formatCpfCnpj(user.cpfCnpj) : "",
      password: "",
      confirmPassword: "",
    });
    setEditingProfile(true);
  };

  const handleProfileSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (profileForm.password && profileForm.password !== profileForm.confirmPassword) {
      toast({ title: "Senhas não coincidem", description: "Confirme a nova senha corretamente.", variant: "destructive" });
      return;
    }
    updateProfileMutation.mutate(profileForm);
  };

  // ── Render: regular user profile view ──
  if (!isSuperAdmin) {
    const me = users[0] ?? null;

    return (
      <div className="space-y-6 animate-in fade-in duration-500 max-w-xl">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Meu Perfil</h1>
          <p className="text-muted-foreground text-sm mt-1">Suas informações de acesso à plataforma.</p>
        </div>

        {isLoading ? (
          <div className="p-8 text-center text-muted-foreground">
            <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2" />
            Carregando...
          </div>
        ) : me ? (
          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center text-xl font-bold text-muted-foreground uppercase">
                  {me.name[0]}
                </div>
                <div>
                  <CardTitle className="text-lg">{me.name}</CardTitle>
                  <CardDescription>@{me.username}</CardDescription>
                </div>
              </div>
              <Button variant="outline" size="sm" className="gap-1.5 shrink-0" onClick={() => handleOpenEditProfile(me)}>
                <Pencil className="w-3.5 h-3.5" />
                Editar
              </Button>
            </CardHeader>
            <CardContent className="grid gap-3 text-sm">
              <div className="flex justify-between py-2 border-b">
                <span className="text-muted-foreground">Perfil de acesso</span>
                <Badge variant="outline" className="gap-1 text-muted-foreground">
                  <User className="w-3 h-3" />
                  Usuário
                </Badge>
              </div>
              <div className="flex justify-between py-2 border-b">
                <span className="text-muted-foreground">CPF / CNPJ</span>
                <span className="font-mono">{me.cpfCnpj ? formatCpfCnpj(me.cpfCnpj) : "—"}</span>
              </div>
              <div className="flex justify-between py-2 border-b">
                <span className="text-muted-foreground">E-mail</span>
                <span>{me.email || "—"}</span>
              </div>
              <div className="flex justify-between py-2">
                <span className="text-muted-foreground">Membro desde</span>
                <span>{format(new Date(me.createdAt), "dd 'de' MMMM 'de' yyyy", { locale: ptBR })}</span>
              </div>
            </CardContent>
          </Card>
        ) : (
          <p className="text-muted-foreground">Nenhuma informação encontrada.</p>
        )}

        {/* Edit Profile Dialog */}
        <Dialog open={editingProfile} onOpenChange={setEditingProfile}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <UserCircle className="w-5 h-5" />
                Editar Perfil
              </DialogTitle>
            </DialogHeader>
            <form onSubmit={handleProfileSubmit} className="space-y-4 mt-2">
              <div className="space-y-2">
                <Label htmlFor="p-name">Nome completo</Label>
                <Input
                  id="p-name"
                  value={profileForm.name}
                  onChange={(e) => setProfileForm((f) => ({ ...f, name: e.target.value }))}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="p-email">E-mail</Label>
                <Input
                  id="p-email"
                  type="email"
                  value={profileForm.email}
                  onChange={(e) => setProfileForm((f) => ({ ...f, email: e.target.value }))}
                  placeholder="seu@email.com"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="p-cpfcnpj">CPF / CNPJ</Label>
                <Input
                  id="p-cpfcnpj"
                  value={profileForm.cpfCnpj}
                  onChange={(e) => setProfileForm((f) => ({ ...f, cpfCnpj: formatCpfCnpj(e.target.value) }))}
                  placeholder="000.000.000-00"
                  maxLength={18}
                />
              </div>
              <div className="border-t pt-3 space-y-3">
                <p className="text-xs text-muted-foreground">Deixe em branco para manter a senha atual.</p>
                <div className="space-y-2">
                  <Label htmlFor="p-password">Nova senha</Label>
                  <Input
                    id="p-password"
                    type="password"
                    value={profileForm.password}
                    onChange={(e) => setProfileForm((f) => ({ ...f, password: e.target.value }))}
                    placeholder="••••••••"
                    autoComplete="new-password"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="p-confirm">Confirmar nova senha</Label>
                  <Input
                    id="p-confirm"
                    type="password"
                    value={profileForm.confirmPassword}
                    onChange={(e) => setProfileForm((f) => ({ ...f, confirmPassword: e.target.value }))}
                    placeholder="••••••••"
                    autoComplete="new-password"
                  />
                </div>
              </div>
              <DialogFooter className="pt-2">
                <Button type="button" variant="outline" onClick={() => setEditingProfile(false)}>Cancelar</Button>
                <Button type="submit" disabled={updateProfileMutation.isPending} className="gap-2">
                  {updateProfileMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
                  Salvar
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>
    );
  }

  // ── Render: super_admin full management view ──
  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Usuários</h1>
          <p className="text-muted-foreground text-sm mt-1">Gerencie os usuários e permissões de acesso à plataforma.</p>
        </div>
        <Button onClick={() => setShowCreate(true)} className="gap-2">
          <Plus className="w-4 h-4" />
          Novo Usuário
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <UserCog className="w-5 h-5" />
            Usuários Cadastrados
          </CardTitle>
          <CardDescription>{users.length} usuário(s) no sistema</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-8 text-center text-muted-foreground">
              <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2" />
              Carregando...
            </div>
          ) : (
            <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-6">Nome</TableHead>
                  <TableHead>Usuário</TableHead>
                  <TableHead>CPF/CNPJ</TableHead>
                  <TableHead>E-mail</TableHead>
                  <TableHead>Perfil</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Criado em</TableHead>
                  <TableHead className="text-right pr-6">Ações</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map((user) => (
                  <TableRow key={user.id} className={!user.isActive ? "opacity-60" : ""}>
                    <TableCell className="pl-6 font-medium">{user.name}</TableCell>
                    <TableCell className="text-muted-foreground">{user.username}</TableCell>
                    <TableCell className="text-muted-foreground font-mono text-xs">
                      {user.cpfCnpj ? formatCpfCnpj(user.cpfCnpj) : "—"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{user.email || "—"}</TableCell>
                    <TableCell>
                      {user.role === "super_admin" ? (
                        <Badge variant="secondary" className="bg-purple-100 text-purple-700 border-purple-200 gap-1">
                          <Shield className="w-3 h-3" />
                          Super Admin
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="gap-1 text-muted-foreground">
                          <User className="w-3 h-3" />
                          Usuário
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      {user.isActive ? (
                        <Badge variant="secondary" className="bg-green-100 text-green-700 border-green-200">
                          Ativo
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-destructive border-destructive/30">
                          Bloqueado
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {format(new Date(user.createdAt), "dd/MM/yyyy", { locale: ptBR })}
                    </TableCell>
                    <TableCell className="text-right pr-6">
                      <div className="flex items-center justify-end gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-8 gap-1.5"
                          onClick={() => handleOpenEditUser(user)}
                        >
                          <Pencil className="w-3.5 h-3.5" /> Editar
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-8 gap-1.5"
                          onClick={() => toggleActiveMutation.mutate({ id: user.id, isActive: !user.isActive })}
                          disabled={toggleActiveMutation.isPending}
                        >
                          {user.isActive ? (
                            <><Lock className="w-3.5 h-3.5" /> Bloquear</>
                          ) : (
                            <><LockOpen className="w-3.5 h-3.5" /> Liberar</>
                          )}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 text-destructive hover:text-destructive hover:bg-destructive/10"
                          onClick={() => setDeleteTarget(user)}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Create User Dialog */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Novo Usuário</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleCreateSubmit} className="space-y-4 mt-2">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="u-name">Nome completo *</Label>
                <Input
                  id="u-name"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="João Silva"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="u-username">Usuário (login) *</Label>
                <Input
                  id="u-username"
                  value={form.username}
                  onChange={(e) => setForm((f) => ({ ...f, username: e.target.value.toLowerCase().trim() }))}
                  placeholder="joao.silva"
                  required
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="u-cpfcnpj">CPF / CNPJ</Label>
              <div className="flex gap-2">
                <Input
                  id="u-cpfcnpj"
                  value={form.cpfCnpj}
                  onChange={(e) => setForm((f) => ({ ...f, cpfCnpj: formatCpfCnpj(e.target.value) }))}
                  placeholder="00.000.000/0000-00 ou 000.000.000-00"
                  maxLength={18}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={handleCnpjSearch}
                  disabled={cnpjLoading || form.cpfCnpj.replace(/\D/g, "").length !== 14}
                  title="Buscar CNPJ"
                >
                  {cnpjLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Para CNPJ, clique na lupa para preencher automaticamente os dados da empresa.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="u-email">E-mail</Label>
              <Input
                id="u-email"
                type="email"
                value={form.email}
                onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                placeholder="joao@empresa.com"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="u-password">Senha *</Label>
                <Input
                  id="u-password"
                  type="password"
                  value={form.password}
                  onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                  placeholder="••••••••"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="u-role">Perfil de acesso</Label>
                <Select value={form.role} onValueChange={(v) => setForm((f) => ({ ...f, role: v }))}>
                  <SelectTrigger id="u-role">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="user">Usuário</SelectItem>
                    <SelectItem value="super_admin">Super Admin</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <DialogFooter className="pt-2">
              <Button type="button" variant="outline" onClick={() => setShowCreate(false)}>
                Cancelar
              </Button>
              <Button type="submit" disabled={createMutation.isPending} className="gap-2">
                {createMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
                Cadastrar Usuário
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Edit User Dialog */}
      <Dialog open={!!editingUser} onOpenChange={(open) => !open && setEditingUser(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Pencil className="w-4 h-4" />
              Editar Usuário — {editingUser?.username}
            </DialogTitle>
          </DialogHeader>
          <form onSubmit={handleEditUserSubmit} className="space-y-4 mt-2">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2 col-span-2">
                <Label htmlFor="eu-name">Nome completo *</Label>
                <Input
                  id="eu-name"
                  value={editForm.name}
                  onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="Nome do usuário"
                  required
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="eu-email">E-mail</Label>
              <Input
                id="eu-email"
                type="email"
                value={editForm.email}
                onChange={(e) => setEditForm((f) => ({ ...f, email: e.target.value }))}
                placeholder="email@empresa.com"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="eu-cpfcnpj">CPF / CNPJ</Label>
                <Input
                  id="eu-cpfcnpj"
                  value={editForm.cpfCnpj}
                  onChange={(e) => setEditForm((f) => ({ ...f, cpfCnpj: formatCpfCnpj(e.target.value) }))}
                  placeholder="000.000.000-00"
                  maxLength={18}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="eu-role">Perfil de acesso</Label>
                <Select value={editForm.role} onValueChange={(v) => setEditForm((f) => ({ ...f, role: v }))}>
                  <SelectTrigger id="eu-role">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="user">Usuário</SelectItem>
                    <SelectItem value="super_admin">Super Admin</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="border-t pt-4 space-y-3">
              <div className="flex items-center gap-2">
                <Lock className="w-4 h-4 text-muted-foreground" />
                <p className="text-sm font-medium">Redefinir senha</p>
              </div>
              <p className="text-xs text-muted-foreground -mt-1">Deixe em branco para manter a senha atual.</p>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="eu-password">Nova senha</Label>
                  <Input
                    id="eu-password"
                    type="password"
                    value={editForm.newPassword}
                    onChange={(e) => setEditForm((f) => ({ ...f, newPassword: e.target.value }))}
                    placeholder="••••••••"
                    autoComplete="new-password"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="eu-confirm">Confirmar senha</Label>
                  <Input
                    id="eu-confirm"
                    type="password"
                    value={editForm.confirmPassword}
                    onChange={(e) => setEditForm((f) => ({ ...f, confirmPassword: e.target.value }))}
                    placeholder="••••••••"
                    autoComplete="new-password"
                  />
                </div>
              </div>
              {editForm.newPassword && editForm.confirmPassword && editForm.newPassword !== editForm.confirmPassword && (
                <p className="text-xs text-destructive">As senhas não coincidem.</p>
              )}
            </div>

            <DialogFooter className="pt-2">
              <Button type="button" variant="outline" onClick={() => setEditingUser(null)}>
                Cancelar
              </Button>
              <Button type="submit" disabled={editUserMutation.isPending} className="gap-2">
                {editUserMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
                Salvar alterações
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirmar exclusão</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Tem certeza que deseja excluir o usuário <strong>{deleteTarget?.name}</strong> ({deleteTarget?.username})?
            Esta ação não pode ser desfeita.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>Cancelar</Button>
            <Button
              variant="destructive"
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
              disabled={deleteMutation.isPending}
              className="gap-2"
            >
              {deleteMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
              Excluir
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
