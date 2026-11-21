import { useListCampaigns } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Link } from "wouter";
import { Plus, MessageSquare, Search, CalendarIcon, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useState } from "react";
import { format, isAfter, isBefore, startOfDay, endOfDay, parseISO } from "date-fns";
import { ptBR } from "date-fns/locale";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type StatusFilter = "todos" | "pendente" | "andamento" | "concluido" | "finalizado";

function getCampaignStatus(campaign: { sentCount: number; totalContacts: number; finishedAt?: string | null; status?: string | null }) {
  if ((campaign as any).status === "finished" || campaign.finishedAt) return "finalizado";
  const progress = campaign.totalContacts > 0
    ? Math.round((campaign.sentCount / campaign.totalContacts) * 100)
    : 0;
  if (progress === 100) return "concluido";
  if (progress > 0) return "andamento";
  return "pendente";
}

export default function CampaignsList() {
  const { data: campaigns, isLoading } = useListCampaigns();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("todos");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const hasActiveFilters = statusFilter !== "todos" || dateFrom !== "" || dateTo !== "";

  function clearFilters() {
    setStatusFilter("todos");
    setDateFrom("");
    setDateTo("");
    setSearch("");
  }

  const filteredCampaigns = (campaigns || []).filter((c) => {
    if (search && !c.name.toLowerCase().includes(search.toLowerCase())) return false;

    if (statusFilter !== "todos") {
      const s = getCampaignStatus(c);
      if (s !== statusFilter) return false;
    }

    const createdAt = new Date(c.createdAt);
    if (dateFrom) {
      const from = startOfDay(parseISO(dateFrom));
      if (isBefore(createdAt, from)) return false;
    }
    if (dateTo) {
      const to = endOfDay(parseISO(dateTo));
      if (isAfter(createdAt, to)) return false;
    }

    return true;
  });

  const statusButtons: { key: StatusFilter; label: string }[] = [
    { key: "todos", label: "Todos" },
    { key: "pendente", label: "Pendente" },
    { key: "andamento", label: "Em andamento" },
    { key: "concluido", label: "Concluído" },
    { key: "finalizado", label: "Finalizado" },
  ];

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight">Campanhas</h1>
          <p className="text-muted-foreground mt-1 text-sm">Gerencie seus disparos e listas de contatos.</p>
        </div>
        <Link href="/campanhas/nova">
          <Button className="gap-2 shrink-0">
            <Plus className="w-4 h-4" /> Nova Campanha
          </Button>
        </Link>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-col gap-4">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div>
                <CardTitle>Todas as Campanhas</CardTitle>
                <CardDescription>Visualize e acesse todas as suas campanhas de disparo.</CardDescription>
              </div>
              <div className="relative w-full sm:w-64">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Buscar por nome..."
                  className="pl-8"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
            </div>

            {/* Filters row */}
            <div className="flex flex-col sm:flex-row gap-3 pt-1 border-t border-border">
              {/* Status filter */}
              <div className="flex items-center gap-1.5 flex-wrap">
                {statusButtons.map(({ key, label }) => (
                  <button
                    key={key}
                    onClick={() => setStatusFilter(key)}
                    className={cn(
                      "px-3 py-1.5 rounded-full text-xs font-medium transition-colors border",
                      statusFilter === key
                        ? "bg-primary text-primary-foreground border-primary"
                        : "bg-muted/50 text-muted-foreground border-transparent hover:border-border hover:text-foreground"
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {/* Date range */}
              <div className="flex items-center gap-2 sm:ml-auto">
                <div className="flex items-center gap-1.5">
                  <CalendarIcon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <Input
                    type="date"
                    className="h-8 text-xs w-36"
                    value={dateFrom}
                    onChange={(e) => setDateFrom(e.target.value)}
                    title="Data de início"
                  />
                </div>
                <span className="text-muted-foreground text-xs shrink-0">até</span>
                <div className="flex items-center gap-1.5">
                  <CalendarIcon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <Input
                    type="date"
                    className="h-8 text-xs w-36"
                    value={dateTo}
                    onChange={(e) => setDateTo(e.target.value)}
                    title="Data de fim"
                  />
                </div>
                {hasActiveFilters && (
                  <button
                    onClick={clearFilters}
                    className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors px-2 py-1 rounded hover:bg-muted"
                    title="Limpar filtros"
                  >
                    <X className="w-3.5 h-3.5" />
                    Limpar
                  </button>
                )}
              </div>
            </div>
          </div>
        </CardHeader>

        <CardContent>
          {isLoading ? (
            <div className="py-12 text-center text-muted-foreground">Carregando...</div>
          ) : filteredCampaigns.length === 0 ? (
            <div className="text-center py-12">
              <MessageSquare className="mx-auto h-12 w-12 text-muted-foreground/30 mb-4" />
              <h3 className="text-lg font-medium text-foreground mb-1">Nenhuma campanha encontrada</h3>
              <p className="text-muted-foreground text-sm">
                {hasActiveFilters || search
                  ? "Nenhuma campanha corresponde aos filtros aplicados."
                  : "Não há campanhas cadastradas."}
              </p>
              {(hasActiveFilters || search) && (
                <button
                  onClick={clearFilters}
                  className="mt-3 text-sm text-primary hover:underline"
                >
                  Limpar filtros
                </button>
              )}
            </div>
          ) : (
            <div className="grid gap-3">
              {filteredCampaigns.map((campaign) => {
                const progress = campaign.totalContacts > 0
                  ? Math.round((campaign.sentCount / campaign.totalContacts) * 100)
                  : 0;
                const status = getCampaignStatus(campaign);

                return (
                  <div key={campaign.id} className="group flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 p-4 border rounded-xl hover:border-primary/50 hover:shadow-sm transition-all bg-card">
                    <div className="flex-1 min-w-0">
                      <Link href={`/campanhas/${campaign.id}`} className="text-base md:text-lg font-semibold hover:text-primary transition-colors line-clamp-1">
                        {campaign.name}
                      </Link>
                      <div className="flex flex-wrap items-center gap-2 mt-1.5 text-sm text-muted-foreground">
                        <span className="flex items-center gap-1.5 truncate max-w-[180px]">
                          <MessageSquare className="w-3.5 h-3.5 shrink-0" />
                          <span className="truncate">{campaign.templateName}</span>
                        </span>
                        <span className="hidden sm:inline">•</span>
                        <span className="text-xs">{format(new Date(campaign.createdAt), "dd MMM yyyy 'às' HH:mm", { locale: ptBR })}</span>
                      </div>
                    </div>

                    <div className="flex items-center justify-between sm:justify-end gap-4 sm:gap-6">
                      <div className="flex flex-col">
                        <div className="text-xl font-bold text-foreground">
                          {campaign.sentCount} <span className="text-sm font-normal text-muted-foreground">/ {campaign.totalContacts}</span>
                        </div>
                        <div className="text-xs text-muted-foreground">Enviadas</div>
                      </div>

                      <Badge
                        className={cn(
                          "shrink-0",
                          status === "finalizado" && "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400 border-purple-200 dark:border-purple-800",
                          status === "concluido" && "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400 border-green-200 dark:border-green-800",
                          status === "andamento" && "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400 border-blue-200 dark:border-blue-800",
                          status === "pendente" && "bg-muted text-muted-foreground border-border"
                        )}
                        variant="outline"
                      >
                        {status === "finalizado" ? "Finalizado" : status === "concluido" ? "Concluído" : status === "andamento" ? `Em andamento ${progress}%` : "Pendente"}
                      </Badge>

                      <Link href={`/campanhas/${campaign.id}`}>
                        <Button variant="secondary" size="sm" className="group-hover:bg-primary group-hover:text-primary-foreground transition-colors shrink-0">
                          Acessar
                        </Button>
                      </Link>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
