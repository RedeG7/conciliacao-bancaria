import { useState, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  Users, Search, Upload, Plus, Trash2, Edit2, Phone, Building2,
  FileSpreadsheet, X, Loader2, MessageCircle, MapPin, Calendar, Briefcase,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useLocation } from "wouter";
import * as XLSX from "xlsx";

interface GlobalContact {
  id: number;
  name: string;
  phone: string;
  cnpj: string | null;
  email: string | null;
  company: string | null;
  city: string | null;
  state: string | null;
  segment: string | null;
  openingDate: string | null;
  zipCode: string | null;
  neighborhood: string | null;
  streetAddress: string | null;
  extraFields: Record<string, string>;
  createdAt: string;
}

interface ContactForm {
  name: string;
  phone: string;
  cnpj: string;
  email: string;
  company: string;
  city: string;
  state: string;
  segment: string;
  openingDate: string;
  zipCode: string;
  neighborhood: string;
  streetAddress: string;
}

const emptyForm: ContactForm = {
  name: "", phone: "", cnpj: "", email: "", company: "",
  city: "", state: "", segment: "", openingDate: "",
  zipCode: "", neighborhood: "", streetAddress: "",
};

async function apiFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    ...opts,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error ?? `HTTP ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export default function ContatosList() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const startConvMutation = useMutation({
    mutationFn: ({ phone, contactName }: { phone: string; contactName: string }) =>
      fetch("/api/conversations/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ phone, contactName }),
      }).then(async (res) => {
        if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error((e as any).error || "Erro"); }
        return res.json();
      }),
    onSuccess: () => navigate("/conversas"),
    onError: (e: any) => toast({ title: e.message || "Erro ao iniciar conversa", variant: "destructive" }),
  });

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [editingContact, setEditingContact] = useState<GlobalContact | null>(null);
  const [showNewDialog, setShowNewDialog] = useState(false);
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [form, setForm] = useState<ContactForm>(emptyForm);
  const [importPreview, setImportPreview] = useState<any[]>([]);
  const [importFileName, setImportFileName] = useState("");

  const searchTimer = useRef<ReturnType<typeof setTimeout>>();

  const { data: contacts = [], isLoading } = useQuery<GlobalContact[]>({
    queryKey: ["global-contacts", debouncedSearch],
    queryFn: () => {
      const url = debouncedSearch
        ? `/api/contacts?q=${encodeURIComponent(debouncedSearch)}`
        : "/api/contacts";
      return apiFetch<GlobalContact[]>(url);
    },
  });

  const createMutation = useMutation({
    mutationFn: (data: any) => apiFetch<any>("/api/contacts", {
      method: "POST",
      body: JSON.stringify(data),
    }),
    onSuccess: (result: any) => {
      qc.invalidateQueries({ queryKey: ["global-contacts"] });
      if (result && typeof result.insertedCount === "number") {
        toast({
          title: result.skippedCount > 0 ? "Importação concluída com avisos" : "Importação concluída",
          description: result.message,
        });
      } else {
        toast({ title: "Contato salvo com sucesso!" });
      }
      setShowNewDialog(false);
      setShowImportDialog(false);
      setForm(emptyForm);
      setImportPreview([]);
      setImportFileName("");
    },
    onError: (e: any) => {
      const msg = e.message || "Erro ao salvar contato";
      const isConflict = msg.includes("já existe") || msg.includes("409");
      toast({
        title: isConflict ? "Contato já cadastrado" : "Erro ao salvar contato",
        description: isConflict ? "Já existe um contato com este número de telefone." : msg,
        variant: "destructive",
      });
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: any }) =>
      apiFetch<GlobalContact>(`/api/contacts/${id}`, { method: "PUT", body: JSON.stringify(data) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["global-contacts"] });
      toast({ title: "Contato atualizado!" });
      setEditingContact(null);
      setForm(emptyForm);
    },
    onError: (e: any) => toast({ title: e.message || "Erro ao atualizar contato", variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiFetch<void>(`/api/contacts/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["global-contacts"] });
      toast({ title: "Contato removido." });
    },
    onError: (e: any) => toast({ title: e.message || "Erro ao remover contato", variant: "destructive" }),
  });

  function handleSearchChange(v: string) {
    setSearch(v);
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => setDebouncedSearch(v), 400);
  }

  function openEdit(c: GlobalContact) {
    setEditingContact(c);
    setForm({
      name: c.name, phone: c.phone,
      cnpj: c.cnpj ?? "", email: c.email ?? "", company: c.company ?? "",
      city: c.city ?? "", state: c.state ?? "", segment: c.segment ?? "",
      openingDate: c.openingDate ?? "", zipCode: c.zipCode ?? "",
      neighborhood: c.neighborhood ?? "", streetAddress: c.streetAddress ?? "",
    });
  }

  function buildPayload(f: ContactForm, extra?: Record<string, any>) {
    return {
      name: f.name, phone: f.phone,
      cnpj: f.cnpj || null, email: f.email || null, company: f.company || null,
      city: f.city || null, state: f.state || null, segment: f.segment || null,
      openingDate: f.openingDate || null, zipCode: f.zipCode || null,
      neighborhood: f.neighborhood || null, streetAddress: f.streetAddress || null,
      extraFields: extra ?? {},
    };
  }

  function handleSaveNew() {
    if (!form.name || !form.phone) {
      toast({ title: "Nome e telefone são obrigatórios.", variant: "destructive" }); return;
    }
    createMutation.mutate(buildPayload(form));
  }

  function handleSaveEdit() {
    if (!editingContact) return;
    if (!form.name || !form.phone) {
      toast({ title: "Nome e telefone são obrigatórios.", variant: "destructive" }); return;
    }
    updateMutation.mutate({ id: editingContact.id, data: buildPayload(form, editingContact.extraFields) });
  }

  function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportFileName(file.name);
    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const bstr = evt.target?.result;
        const wb = XLSX.read(bstr, { type: "binary" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const data = XLSX.utils.sheet_to_json(ws) as Record<string, any>[];
        const parsed = data.map((row) => {
          const c: any = { name: "", phone: "", extraFields: {} };
          Object.keys(row).forEach((key) => {
            const lk = key.toLowerCase().trim();
            const val = String(row[key]);
            if (lk === "nome" || lk === "name") c.name = val;
            else if (["telefone", "phone", "celular"].includes(lk)) c.phone = val;
            else if (lk === "cnpj") c.cnpj = val;
            else if (["email", "e-mail"].includes(lk)) c.email = val;
            else if (["empresa", "company", "razão social", "razao social"].includes(lk)) c.company = val;
            else if (["cidade", "city"].includes(lk)) c.city = val;
            else if (["estado", "state", "uf"].includes(lk)) c.state = val;
            else if (["segmento", "segment", "ramo", "atividade"].includes(lk)) c.segment = val;
            else if (["abertura", "data abertura", "opening_date", "data_abertura"].includes(lk)) c.openingDate = val;
            else if (["cep", "zipcode", "zip_code"].includes(lk)) c.zipCode = val;
            else if (["bairro", "neighborhood"].includes(lk)) c.neighborhood = val;
            else if (["logradouro", "endereço", "address", "street"].includes(lk)) c.streetAddress = val;
            else c.extraFields[key] = val;
          });
          return c;
        }).filter((c: any) => c.name && c.phone);
        setImportPreview(parsed);
        if (parsed.length === 0) {
          toast({ title: "Nenhum contato válido encontrado", description: "Verifique se a planilha tem colunas 'Nome' e 'Telefone'.", variant: "destructive" });
        } else {
          toast({ title: `${parsed.length} contatos encontrados`, description: "Revise a prévia e confirme." });
        }
      } catch {
        toast({ title: "Erro ao ler o arquivo", variant: "destructive" });
      }
    };
    reader.readAsBinaryString(file);
  }

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Contatos</h1>
          <p className="text-muted-foreground mt-1">Base de dados de todos os seus contatos.</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Button variant="outline" className="gap-2" onClick={() => setShowImportDialog(true)}>
            <Upload className="w-4 h-4" /> Importar planilha
          </Button>
          <Button className="gap-2" onClick={() => { setShowNewDialog(true); setForm(emptyForm); }}>
            <Plus className="w-4 h-4" /> Novo contato
          </Button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-5 flex items-center gap-4">
            <div className="w-10 h-10 rounded-xl bg-green-50 dark:bg-green-900/30 flex items-center justify-center">
              <Users className="w-5 h-5 text-green-600" />
            </div>
            <div>
              <p className="text-2xl font-bold">{contacts.length}</p>
              <p className="text-xs text-muted-foreground">Total</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-5 flex items-center gap-4">
            <div className="w-10 h-10 rounded-xl bg-blue-50 dark:bg-blue-900/30 flex items-center justify-center">
              <Building2 className="w-5 h-5 text-blue-600" />
            </div>
            <div>
              <p className="text-2xl font-bold">{contacts.filter(c => c.cnpj).length}</p>
              <p className="text-xs text-muted-foreground">Com CNPJ</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-5 flex items-center gap-4">
            <div className="w-10 h-10 rounded-xl bg-purple-50 dark:bg-purple-900/30 flex items-center justify-center">
              <MapPin className="w-5 h-5 text-purple-600" />
            </div>
            <div>
              <p className="text-2xl font-bold">{new Set(contacts.filter(c => c.city).map(c => c.city)).size}</p>
              <p className="text-xs text-muted-foreground">Cidades</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-5 flex items-center gap-4">
            <div className="w-10 h-10 rounded-xl bg-orange-50 dark:bg-orange-900/30 flex items-center justify-center">
              <Briefcase className="w-5 h-5 text-orange-600" />
            </div>
            <div>
              <p className="text-2xl font-bold">{new Set(contacts.filter(c => c.segment).map(c => c.segment)).size}</p>
              <p className="text-xs text-muted-foreground">Segmentos</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Search + table */}
      <Card>
        <CardHeader className="pb-3">
          <div className="relative max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="Buscar por nome, telefone, CNPJ, cidade..."
              className="pl-9 pr-8"
              value={search}
              onChange={e => handleSearchChange(e.target.value)}
            />
            {search && (
              <button onClick={() => { setSearch(""); setDebouncedSearch(""); }} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
          ) : contacts.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3 text-muted-foreground">
              <Users className="w-10 h-10" />
              <p className="font-medium">{debouncedSearch ? "Nenhum contato encontrado" : "Nenhum contato cadastrado"}</p>
              {!debouncedSearch && <p className="text-sm text-center">Importe uma planilha ou adicione contatos manualmente.</p>}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Nome</TableHead>
                    <TableHead>Telefone</TableHead>
                    <TableHead>Empresa / CNPJ</TableHead>
                    <TableHead>Cidade / Estado</TableHead>
                    <TableHead>Segmento</TableHead>
                    <TableHead>Abertura</TableHead>
                    <TableHead className="w-[100px]">Ações</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {contacts.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell className="font-medium">{c.name}</TableCell>
                      <TableCell className="text-sm">{c.phone}</TableCell>
                      <TableCell>
                        <div className="text-sm">{c.company || "—"}</div>
                        {c.cnpj && <div className="text-xs text-muted-foreground font-mono">{c.cnpj}</div>}
                      </TableCell>
                      <TableCell>
                        {c.city ? (
                          <div className="text-sm">{c.city}{c.state ? ` - ${c.state}` : ""}</div>
                        ) : "—"}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground max-w-[160px] truncate" title={c.segment ?? ""}>
                        {c.segment ? c.segment.length > 30 ? c.segment.slice(0, 28) + "…" : c.segment : "—"}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {c.openingDate ? c.openingDate.slice(0, 10) : "—"}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => startConvMutation.mutate({ phone: c.phone, contactName: c.name })}
                            className="p-1.5 rounded hover:bg-green-50 dark:hover:bg-green-900/20 transition-colors text-muted-foreground hover:text-green-600"
                            title="Iniciar conversa"
                          >
                            <MessageCircle className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => openEdit(c)}
                            className="p-1.5 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
                          >
                            <Edit2 className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => { if (confirm("Remover este contato?")) deleteMutation.mutate(c.id); }}
                            className="p-1.5 rounded hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors text-muted-foreground hover:text-red-600"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
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

      {/* New Contact Dialog */}
      <Dialog open={showNewDialog} onOpenChange={setShowNewDialog}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Novo Contato</DialogTitle>
          </DialogHeader>
          <ContactFormFields form={form} onChange={setForm} toast={toast} />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowNewDialog(false)}>Cancelar</Button>
            <Button onClick={handleSaveNew} disabled={createMutation.isPending} className="gap-2">
              {createMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
              Salvar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Contact Dialog */}
      <Dialog open={!!editingContact} onOpenChange={v => { if (!v) setEditingContact(null); }}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Editar Contato</DialogTitle>
          </DialogHeader>
          <ContactFormFields form={form} onChange={setForm} toast={toast} />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEditingContact(null)}>Cancelar</Button>
            <Button onClick={handleSaveEdit} disabled={updateMutation.isPending} className="gap-2">
              {updateMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
              Salvar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Import Dialog */}
      <Dialog open={showImportDialog} onOpenChange={v => {
        if (!v) { setShowImportDialog(false); setImportPreview([]); setImportFileName(""); if (fileInputRef.current) fileInputRef.current.value = ""; }
      }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Importar Contatos via Planilha</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div
              className="border-2 border-dashed rounded-xl p-6 text-center bg-muted/20 hover:bg-muted/40 transition-colors cursor-pointer"
              onClick={() => fileInputRef.current?.click()}
            >
              <input type="file" ref={fileInputRef} className="hidden" accept=".csv,.xlsx,.xls" onChange={handleFileUpload} />
              <FileSpreadsheet className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
              <p className="font-medium">{importFileName || "Clique para selecionar arquivo"}</p>
              <p className="text-sm text-muted-foreground mt-1">
                Colunas: Nome*, Telefone*, CNPJ, Email, Empresa, Cidade, Estado, Segmento, Abertura, CEP, Bairro, Logradouro
              </p>
              <p className="text-xs text-green-600 mt-0.5">* Obrigatório</p>
            </div>

            {importPreview.length > 0 && (
              <div>
                <p className="text-sm font-medium mb-2">{importPreview.length} contatos encontrados — prévia:</p>
                <div className="border rounded-lg max-h-48 overflow-y-auto overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Nome</TableHead>
                        <TableHead>Telefone</TableHead>
                        <TableHead>Empresa</TableHead>
                        <TableHead>Cidade</TableHead>
                        <TableHead>Segmento</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {importPreview.slice(0, 8).map((c, i) => (
                        <TableRow key={i}>
                          <TableCell className="text-xs">{c.name}</TableCell>
                          <TableCell className="text-xs">{c.phone}</TableCell>
                          <TableCell className="text-xs text-muted-foreground">{c.company || "—"}</TableCell>
                          <TableCell className="text-xs text-muted-foreground">{c.city || "—"}</TableCell>
                          <TableCell className="text-xs text-muted-foreground">{c.segment ? c.segment.slice(0, 20) + (c.segment.length > 20 ? "…" : "") : "—"}</TableCell>
                        </TableRow>
                      ))}
                      {importPreview.length > 8 && (
                        <TableRow>
                          <TableCell colSpan={5} className="text-center text-xs text-muted-foreground py-2">
                            + {importPreview.length - 8} contatos
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => { setShowImportDialog(false); setImportPreview([]); setImportFileName(""); }}>Cancelar</Button>
            <Button
              onClick={() => createMutation.mutate(importPreview)}
              disabled={importPreview.length === 0 || createMutation.isPending}
              className="gap-2"
            >
              {createMutation.isPending
                ? <><Loader2 className="w-4 h-4 animate-spin" /> Importando...</>
                : <><Upload className="w-4 h-4" /> Importar {importPreview.length > 0 ? `${importPreview.length} contatos` : ""}</>}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ContactFormFields({
  form,
  onChange,
  toast,
}: {
  form: ContactForm;
  onChange: (f: ContactForm) => void;
  toast: any;
}) {
  const [lookingUp, setLookingUp] = useState(false);

  async function lookupCnpj() {
    const cnpj = form.cnpj.replace(/\D/g, "");
    if (cnpj.length !== 14) {
      toast({ title: "Digite um CNPJ com 14 dígitos.", variant: "destructive" });
      return;
    }
    setLookingUp(true);
    try {
      const res = await fetch(`/api/contacts/cnpj/${cnpj}`, { credentials: "include" });
      const data = await res.json();
      if (!res.ok) { toast({ title: data.error || "CNPJ não encontrado.", variant: "destructive" }); return; }

      onChange({
        ...form,
        company: data.company ?? form.company,
        email: data.email ?? form.email,
        city: data.city ?? form.city,
        state: data.state ?? form.state,
        segment: data.segment ?? form.segment,
        openingDate: data.openingDate ?? form.openingDate,
        zipCode: data.zipCode ?? form.zipCode,
        neighborhood: data.neighborhood ?? form.neighborhood,
        streetAddress: data.streetAddress ?? form.streetAddress,
        phone: form.phone || (data.phone ?? ""),
      });
      toast({ title: "Dados preenchidos pelo CNPJ!", description: data.company ?? "" });
    } catch {
      toast({ title: "Erro ao consultar CNPJ.", variant: "destructive" });
    } finally {
      setLookingUp(false);
    }
  }

  return (
    <div className="space-y-5">
      {/* Row 1: Name + Phone */}
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>Nome <span className="text-red-500">*</span></Label>
          <Input value={form.name} onChange={e => onChange({ ...form, name: e.target.value })} placeholder="João da Silva" />
        </div>
        <div className="space-y-2">
          <Label>Telefone <span className="text-red-500">*</span></Label>
          <Input value={form.phone} onChange={e => onChange({ ...form, phone: e.target.value })} placeholder="5562 99999999" />
        </div>
      </div>

      {/* Row 2: CNPJ with lookup button */}
      <div className="space-y-2">
        <Label className="flex items-center gap-1.5">
          <Building2 className="w-3.5 h-3.5" /> CNPJ
        </Label>
        <div className="flex gap-2">
          <Input
            value={form.cnpj}
            onChange={e => onChange({ ...form, cnpj: e.target.value })}
            placeholder="00.000.000/0001-00"
            className="flex-1"
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={lookupCnpj}
            disabled={lookingUp || form.cnpj.replace(/\D/g, "").length !== 14}
            className="shrink-0 gap-1.5 h-10"
          >
            {lookingUp ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
            Consultar
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">Digite o CNPJ e clique em Consultar para preencher automaticamente</p>
      </div>

      {/* Row 3: Company + Email */}
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>Razão Social / Empresa</Label>
          <Input value={form.company} onChange={e => onChange({ ...form, company: e.target.value })} placeholder="Nome da empresa" />
        </div>
        <div className="space-y-2">
          <Label>Email</Label>
          <Input type="email" value={form.email} onChange={e => onChange({ ...form, email: e.target.value })} placeholder="email@empresa.com" />
        </div>
      </div>

      <div className="border-t pt-4">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3 flex items-center gap-1.5">
          <MapPin className="w-3.5 h-3.5" /> Localização
        </p>
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2 space-y-2">
              <Label>Cidade</Label>
              <Input value={form.city} onChange={e => onChange({ ...form, city: e.target.value })} placeholder="Goiânia" />
            </div>
            <div className="space-y-2">
              <Label>Estado (UF)</Label>
              <Input value={form.state} onChange={e => onChange({ ...form, state: e.target.value })} placeholder="GO" maxLength={2} />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-2">
              <Label>CEP</Label>
              <Input value={form.zipCode} onChange={e => onChange({ ...form, zipCode: e.target.value })} placeholder="74000-000" />
            </div>
            <div className="space-y-2">
              <Label>Bairro</Label>
              <Input value={form.neighborhood} onChange={e => onChange({ ...form, neighborhood: e.target.value })} placeholder="Centro" />
            </div>
            <div className="space-y-2">
              <Label>Logradouro</Label>
              <Input value={form.streetAddress} onChange={e => onChange({ ...form, streetAddress: e.target.value })} placeholder="Rua das Flores, 123" />
            </div>
          </div>
        </div>
      </div>

      <div className="border-t pt-4">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3 flex items-center gap-1.5">
          <Briefcase className="w-3.5 h-3.5" /> Dados Empresariais
        </p>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label className="flex items-center gap-1.5">
              <Briefcase className="w-3.5 h-3.5" /> Segmento / Atividade
            </Label>
            <Input value={form.segment} onChange={e => onChange({ ...form, segment: e.target.value })} placeholder="Comércio varejista" />
          </div>
          <div className="space-y-2">
            <Label className="flex items-center gap-1.5">
              <Calendar className="w-3.5 h-3.5" /> Data de Abertura
            </Label>
            <Input type="date" value={form.openingDate} onChange={e => onChange({ ...form, openingDate: e.target.value })} />
          </div>
        </div>
      </div>
    </div>
  );
}
