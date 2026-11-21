import { useState, useRef } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { useListTemplates, useCreateCampaign } from "@workspace/api-client-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Upload, ArrowRight, Loader2, AlertCircle, FileSpreadsheet,
  Users, Search, X, Filter, CheckSquare, Square, MapPin, Briefcase, Calendar,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import * as XLSX from "xlsx";
import { ContactInput } from "@workspace/api-client-react/src/generated/api.schemas";

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
  extraFields: Record<string, string>;
}

async function apiFetch<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: "include" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export default function NewCampaign() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const { data: templates, isLoading: isLoadingTemplates } = useListTemplates();
  const createCampaign = useCreateCampaign();

  const [step, setStep] = useState<1 | 2>(1);
  const [name, setName] = useState("");
  const [templateId, setTemplateId] = useState<string>("");
  const [contacts, setContacts] = useState<ContactInput[]>([]);
  const [fileName, setFileName] = useState<string>("");

  // Contact source mode
  const [contactMode, setContactMode] = useState<"xlsx" | "system">("xlsx");

  // System contacts filters
  const [filterPhone, setFilterPhone] = useState("");
  const [filterCity, setFilterCity] = useState("");
  const [filterSegment, setFilterSegment] = useState("");
  const [filterOpeningFrom, setFilterOpeningFrom] = useState("");
  const [filterOpeningTo, setFilterOpeningTo] = useState("");
  const [appliedFilters, setAppliedFilters] = useState<Record<string, string>>({});
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [selectQty, setSelectQty] = useState<string>("todos");

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Build query string for global contacts
  const systemParams = new URLSearchParams();
  if (appliedFilters.phone) systemParams.set("q", appliedFilters.phone);
  if (appliedFilters.city) systemParams.set("city", appliedFilters.city);
  if (appliedFilters.segment) systemParams.set("segment", appliedFilters.segment);
  if (appliedFilters.openingFrom) systemParams.set("openingDateFrom", appliedFilters.openingFrom);
  if (appliedFilters.openingTo) systemParams.set("openingDateTo", appliedFilters.openingTo);

  const { data: systemContacts = [], isFetching: isFetchingSystem } = useQuery<GlobalContact[]>({
    queryKey: ["global-contacts-campaign", appliedFilters],
    queryFn: () => apiFetch<GlobalContact[]>(`/api/contacts?${systemParams}`),
    enabled: contactMode === "system",
  });

  function applyFilters() {
    setAppliedFilters({
      phone: filterPhone,
      city: filterCity,
      segment: filterSegment,
      openingFrom: filterOpeningFrom,
      openingTo: filterOpeningTo,
    });
    setSelectedIds(new Set());
  }

  function clearFilters() {
    setFilterPhone(""); setFilterCity(""); setFilterSegment(""); setFilterOpeningFrom(""); setFilterOpeningTo("");
    setAppliedFilters({});
    setSelectedIds(new Set());
  }

  function selectByQuantity() {
    const n = selectQty === "todos" ? systemContacts.length : parseInt(selectQty, 10);
    const ids = systemContacts.slice(0, n).map(c => c.id);
    setSelectedIds(new Set(ids));
  }

  function toggleId(id: number) {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (selectedIds.size === systemContacts.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(systemContacts.map(c => c.id)));
    }
  }

  function confirmSystemContacts() {
    const chosen = systemContacts
      .filter(c => selectedIds.has(c.id))
      .map(c => ({
        name: c.name,
        phone: c.phone,
        extraFields: {
          ...(c.company ? { empresa: c.company } : {}),
          ...(c.city ? { cidade: c.city } : {}),
          ...(c.segment ? { segmento: c.segment } : {}),
          ...(c.email ? { email: c.email } : {}),
          ...c.extraFields,
        },
      }));
    if (chosen.length === 0) {
      toast({ title: "Selecione ao menos um contato.", variant: "destructive" });
      return;
    }
    setContacts(chosen);
    toast({ title: `${chosen.length} contatos selecionados!` });
  }

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const bstr = evt.target?.result;
        const wb = XLSX.read(bstr, { type: "binary" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const data = XLSX.utils.sheet_to_json(ws) as Record<string, any>[];
        const parsedContacts: ContactInput[] = data.map((row) => {
          let name = "", phone = "";
          const extraFields: Record<string, string> = {};
          Object.keys(row).forEach((key) => {
            const lk = key.toLowerCase().trim();
            const val = String(row[key]);
            if (lk === "nome" || lk === "name") name = val;
            else if (["telefone", "phone", "celular"].includes(lk)) phone = val;
            else extraFields[key] = val;
          });
          return { name, phone, extraFields };
        }).filter(c => c.name && c.phone);
        setContacts(parsedContacts);
        if (parsedContacts.length === 0) {
          toast({ title: "Erro na importação", description: "Não foi possível encontrar colunas 'Nome' e 'Telefone'.", variant: "destructive" });
        } else {
          toast({ title: "Planilha importada", description: `${parsedContacts.length} contatos encontrados.` });
        }
      } catch {
        toast({ title: "Erro ao ler o arquivo", variant: "destructive" });
      }
    };
    reader.readAsBinaryString(file);
  };

  const handleCreate = () => {
    if (!name || !templateId || contacts.length === 0) {
      toast({ title: "Campos obrigatórios", description: "Preencha o nome, escolha um template e selecione os contatos.", variant: "destructive" });
      return;
    }
    createCampaign.mutate({ data: { name, templateId: parseInt(templateId, 10), contacts } }, {
      onSuccess: (campaign) => {
        toast({ title: "Campanha criada com sucesso!" });
        setLocation(`/campanhas/${campaign.id}`);
      },
      onError: () => {
        toast({ title: "Erro ao criar", description: "Não foi possível criar a campanha. Tente novamente.", variant: "destructive" });
      }
    });
  };

  const hasFilters = !!(filterPhone || filterCity || filterSegment || filterOpeningFrom || filterOpeningTo);
  const hasApplied = Object.values(appliedFilters).some(Boolean);

  return (
    <div className="max-w-3xl mx-auto space-y-6 animate-in fade-in duration-500">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Nova Campanha</h1>
        <p className="text-muted-foreground mt-1">Crie um novo disparo de WhatsApp em poucos passos.</p>
      </div>

      <div className="flex gap-4 mb-8">
        <div className={`flex-1 h-2 rounded-full ${step >= 1 ? "bg-primary" : "bg-muted"}`} />
        <div className={`flex-1 h-2 rounded-full ${step >= 2 ? "bg-primary" : "bg-muted"}`} />
      </div>

      {step === 1 && (
        <Card>
          <CardHeader>
            <CardTitle>Configurações Básicas</CardTitle>
            <CardDescription>Defina o nome da campanha e escolha a mensagem.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-2">
              <Label htmlFor="name">Nome da Campanha</Label>
              <Input id="name" placeholder="Ex: Promoção Dia das Mães" value={name} onChange={e => setName(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="template">Template de Mensagem</Label>
              {isLoadingTemplates ? (
                <div className="flex items-center h-10 px-3 text-sm border rounded-md bg-muted/50 text-muted-foreground">Carregando templates...</div>
              ) : templates?.length === 0 ? (
                <div className="p-4 border rounded-md border-dashed text-sm flex flex-col items-center justify-center gap-2 text-muted-foreground">
                  <AlertCircle className="h-5 w-5" />
                  <p>Você precisa criar um template primeiro.</p>
                  <Button variant="outline" size="sm" onClick={() => setLocation("/templates")}>Ir para Templates</Button>
                </div>
              ) : (
                <Select value={templateId} onValueChange={setTemplateId}>
                  <SelectTrigger id="template">
                    <SelectValue placeholder="Selecione um template..." />
                  </SelectTrigger>
                  <SelectContent>
                    {templates?.map(t => <SelectItem key={t.id} value={t.id.toString()}>{t.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              )}
            </div>
          </CardContent>
          <CardFooter className="justify-end">
            <Button onClick={() => setStep(2)} disabled={!name || !templateId} className="gap-2">
              Próximo <ArrowRight className="w-4 h-4" />
            </Button>
          </CardFooter>
        </Card>
      )}

      {step === 2 && (
        <Card>
          <CardHeader>
            <CardTitle>Selecionar Contatos</CardTitle>
            <CardDescription>Importe uma planilha ou use os contatos cadastrados no sistema.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">

            {/* Source tabs */}
            <div className="flex rounded-lg border overflow-hidden">
              <button
                onClick={() => { setContactMode("xlsx"); setContacts([]); setFileName(""); }}
                className={`flex-1 py-2.5 text-sm font-medium flex items-center justify-center gap-2 transition-colors ${contactMode === "xlsx" ? "bg-primary text-primary-foreground" : "bg-muted/30 text-muted-foreground hover:bg-muted/60"}`}
              >
                <FileSpreadsheet className="w-4 h-4" /> Importar Planilha
              </button>
              <button
                onClick={() => { setContactMode("system"); setContacts([]); setFileName(""); }}
                className={`flex-1 py-2.5 text-sm font-medium flex items-center justify-center gap-2 transition-colors ${contactMode === "system" ? "bg-primary text-primary-foreground" : "bg-muted/30 text-muted-foreground hover:bg-muted/60"}`}
              >
                <Users className="w-4 h-4" /> Contatos do Sistema
              </button>
            </div>

            {/* --- XLSX MODE --- */}
            {contactMode === "xlsx" && (
              <div className="space-y-5">
                <div
                  className="border-2 border-dashed rounded-xl p-8 text-center bg-muted/20 hover:bg-muted/50 transition-colors cursor-pointer"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <input
                    type="file"
                    ref={fileInputRef}
                    accept=".csv, application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, application/vnd.ms-excel"
                    className="hidden"
                    onChange={handleFileUpload}
                  />
                  <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center text-primary mx-auto mb-4">
                    <FileSpreadsheet className="w-8 h-8" />
                  </div>
                  <div className="text-lg font-semibold">{fileName || "Clique para selecionar arquivo"}</div>
                  <div className="text-sm text-muted-foreground mt-1">.xlsx, .xls ou .csv — colunas Nome* e Telefone*</div>
                  <Button variant="outline" className="mt-4 pointer-events-none">Selecionar Arquivo</Button>
                </div>

                {contacts.length > 0 && (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <h3 className="font-medium">{contacts.length} contatos carregados</h3>
                      <Button variant="ghost" size="sm" className="gap-1 h-7 text-muted-foreground" onClick={() => { setContacts([]); setFileName(""); }}>
                        <X className="w-3.5 h-3.5" /> Limpar
                      </Button>
                    </div>
                    <div className="border rounded-md max-h-56 overflow-y-auto overflow-x-auto">
                      <Table>
                        <TableHeader className="sticky top-0 bg-muted/80 backdrop-blur-sm">
                          <TableRow>
                            <TableHead>Nome</TableHead>
                            <TableHead>Telefone</TableHead>
                            <TableHead>Campos Extras</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {contacts.slice(0, 10).map((c, i) => (
                            <TableRow key={i}>
                              <TableCell className="font-medium">{c.name}</TableCell>
                              <TableCell>{c.phone}</TableCell>
                              <TableCell className="text-muted-foreground text-xs">
                                {Object.keys(c.extraFields || {}).length > 0
                                  ? Object.entries(c.extraFields || {}).map(([k, v]) => `${k}: ${v}`).join(", ")
                                  : "—"}
                              </TableCell>
                            </TableRow>
                          ))}
                          {contacts.length > 10 && (
                            <TableRow>
                              <TableCell colSpan={3} className="text-center text-muted-foreground py-3 text-sm">
                                + {contacts.length - 10} contatos na lista
                              </TableCell>
                            </TableRow>
                          )}
                        </TableBody>
                      </Table>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* --- SYSTEM CONTACTS MODE --- */}
            {contactMode === "system" && (
              <div className="space-y-4">
                {/* Filters */}
                <div className="bg-muted/30 rounded-xl p-4 space-y-3 border">
                  <p className="text-sm font-semibold flex items-center gap-1.5 text-muted-foreground">
                    <Filter className="w-3.5 h-3.5" /> Filtrar contatos
                  </p>
                  <div className="space-y-1.5">
                    <Label className="text-xs flex items-center gap-1"><Search className="w-3 h-3" /> Telefone</Label>
                    <Input
                      value={filterPhone}
                      onChange={e => setFilterPhone(e.target.value)}
                      onKeyDown={e => e.key === "Enter" && applyFilters()}
                      placeholder="Ex: 5562 99999999"
                      className="h-8 text-sm"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label className="text-xs flex items-center gap-1"><MapPin className="w-3 h-3" /> Cidade</Label>
                      <Input
                        value={filterCity}
                        onChange={e => setFilterCity(e.target.value)}
                        placeholder="Ex: Goiânia"
                        className="h-8 text-sm"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs flex items-center gap-1"><Briefcase className="w-3 h-3" /> Segmento</Label>
                      <Input
                        value={filterSegment}
                        onChange={e => setFilterSegment(e.target.value)}
                        placeholder="Ex: Comércio"
                        className="h-8 text-sm"
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label className="text-xs flex items-center gap-1"><Calendar className="w-3 h-3" /> Abertura de</Label>
                      <Input
                        type="date"
                        value={filterOpeningFrom}
                        onChange={e => setFilterOpeningFrom(e.target.value)}
                        className="h-8 text-sm"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs flex items-center gap-1"><Calendar className="w-3 h-3" /> Abertura até</Label>
                      <Input
                        type="date"
                        value={filterOpeningTo}
                        onChange={e => setFilterOpeningTo(e.target.value)}
                        className="h-8 text-sm"
                      />
                    </div>
                  </div>
                  <div className="flex gap-2 pt-1">
                    <Button size="sm" onClick={applyFilters} disabled={isFetchingSystem} className="gap-1.5 h-8">
                      {isFetchingSystem ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
                      Buscar
                    </Button>
                    {hasApplied && (
                      <Button size="sm" variant="ghost" onClick={clearFilters} className="gap-1.5 h-8 text-muted-foreground">
                        <X className="w-3.5 h-3.5" /> Limpar filtros
                      </Button>
                    )}
                  </div>
                </div>

                {/* Results */}
                {isFetchingSystem ? (
                  <div className="flex items-center justify-center py-10 text-muted-foreground gap-2">
                    <Loader2 className="w-5 h-5 animate-spin" /> Buscando contatos...
                  </div>
                ) : systemContacts.length === 0 && hasApplied ? (
                  <div className="flex flex-col items-center justify-center py-10 text-muted-foreground gap-2">
                    <Users className="w-8 h-8" />
                    <p className="text-sm font-medium">Nenhum contato encontrado</p>
                    <p className="text-xs text-center">Tente ajustar os filtros ou cadastre mais contatos.</p>
                  </div>
                ) : systemContacts.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-10 text-muted-foreground gap-2">
                    <Search className="w-8 h-8" />
                    <p className="text-sm font-medium">Use os filtros acima para buscar contatos</p>
                    <p className="text-xs">Você pode buscar por cidade, segmento ou data de abertura</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <p className="text-sm text-muted-foreground">
                        {systemContacts.length} contato{systemContacts.length !== 1 ? "s" : ""} encontrado{systemContacts.length !== 1 ? "s" : ""}
                        {selectedIds.size > 0 && <span className="ml-2 text-primary font-medium">— {selectedIds.size} selecionado{selectedIds.size !== 1 ? "s" : ""}</span>}
                      </p>
                      <div className="flex items-center gap-2">
                        <div className="flex items-center gap-1.5">
                          <Label className="text-xs text-muted-foreground whitespace-nowrap">Selecionar:</Label>
                          <Select value={selectQty} onValueChange={setSelectQty}>
                            <SelectTrigger className="h-7 text-xs w-24">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="10">10</SelectItem>
                              <SelectItem value="25">25</SelectItem>
                              <SelectItem value="50">50</SelectItem>
                              <SelectItem value="100">100</SelectItem>
                              <SelectItem value="200">200</SelectItem>
                              <SelectItem value="todos">Todos</SelectItem>
                            </SelectContent>
                          </Select>
                          <Button size="sm" variant="outline" className="h-7 text-xs px-2" onClick={selectByQuantity}>
                            OK
                          </Button>
                        </div>
                        <button
                          onClick={toggleAll}
                          className="text-xs text-primary hover:underline flex items-center gap-1"
                        >
                          {selectedIds.size === systemContacts.length
                            ? <><CheckSquare className="w-3.5 h-3.5" /> Desmarcar</>
                            : <><Square className="w-3.5 h-3.5" /> Todos</>}
                        </button>
                      </div>
                    </div>

                    <div className="border rounded-lg max-h-64 overflow-y-auto">
                      <Table>
                        <TableHeader className="sticky top-0 bg-muted/80 backdrop-blur-sm">
                          <TableRow>
                            <TableHead className="w-8"></TableHead>
                            <TableHead>Nome</TableHead>
                            <TableHead>Telefone</TableHead>
                            <TableHead>Cidade</TableHead>
                            <TableHead>Segmento</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {systemContacts.map(c => (
                            <TableRow
                              key={c.id}
                              className={`cursor-pointer ${selectedIds.has(c.id) ? "bg-primary/5" : ""}`}
                              onClick={() => toggleId(c.id)}
                            >
                              <TableCell>
                                <div className={`w-4 h-4 rounded border flex items-center justify-center transition-colors ${selectedIds.has(c.id) ? "bg-primary border-primary" : "border-muted-foreground/40"}`}>
                                  {selectedIds.has(c.id) && <svg className="w-3 h-3 text-primary-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>}
                                </div>
                              </TableCell>
                              <TableCell className="font-medium text-sm">{c.name}</TableCell>
                              <TableCell className="text-sm">{c.phone}</TableCell>
                              <TableCell className="text-sm text-muted-foreground">{c.city || "—"}</TableCell>
                              <TableCell className="text-xs text-muted-foreground max-w-[140px] truncate">{c.segment ? c.segment.slice(0, 25) + (c.segment.length > 25 ? "…" : "") : "—"}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>

                    {selectedIds.size > 0 && contacts.length === 0 && (
                      <Button onClick={confirmSystemContacts} className="w-full gap-2" variant="outline">
                        <CheckSquare className="w-4 h-4" /> Confirmar {selectedIds.size} contato{selectedIds.size !== 1 ? "s" : ""} selecionado{selectedIds.size !== 1 ? "s" : ""}
                      </Button>
                    )}

                    {contacts.length > 0 && (
                      <div className="flex items-center justify-between p-3 bg-green-50 dark:bg-green-900/20 rounded-lg border border-green-200 dark:border-green-800">
                        <p className="text-sm text-green-700 dark:text-green-300 font-medium">
                          {contacts.length} contato{contacts.length !== 1 ? "s" : ""} confirmado{contacts.length !== 1 ? "s" : ""} para a campanha
                        </p>
                        <Button size="sm" variant="ghost" className="h-7 gap-1 text-muted-foreground" onClick={() => { setContacts([]); setSelectedIds(new Set()); }}>
                          <X className="w-3 h-3" /> Refazer
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

          </CardContent>
          <CardFooter className="justify-between">
            <Button variant="ghost" onClick={() => setStep(1)}>Voltar</Button>
            <Button
              onClick={handleCreate}
              disabled={contacts.length === 0 || createCampaign.isPending}
              className="gap-2"
            >
              {createCampaign.isPending
                ? <><Loader2 className="w-4 h-4 animate-spin" /> Criando...</>
                : <><Upload className="w-4 h-4" /> Criar Campanha ({contacts.length} contatos)</>}
            </Button>
          </CardFooter>
        </Card>
      )}
    </div>
  );
}
