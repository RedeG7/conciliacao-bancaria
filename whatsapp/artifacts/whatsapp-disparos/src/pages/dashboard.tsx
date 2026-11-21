import { useGetCampaignsSummary, useListCampaigns } from "@workspace/api-client-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { MessageCircle, Users, CheckCircle2, Clock, Reply, Flag } from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Legend,
} from "recharts";

function getCampaignStatus(campaign: { sentCount: number; totalContacts: number; finishedAt?: string | null; status?: string | null }) {
  if ((campaign as any).status === "finished" || campaign.finishedAt) return "finalizado";
  const progress = campaign.totalContacts > 0
    ? Math.round((campaign.sentCount / campaign.totalContacts) * 100)
    : 0;
  if (progress === 100) return "concluido";
  if (progress > 0) return "andamento";
  return "pendente";
}

const STATUS_COLORS = {
  finalizado: "#a855f7",
  concluido: "#22c55e",
  andamento: "#3b82f6",
  pendente: "#94a3b8",
};

const STATUS_LABELS = {
  finalizado: "Finalizado",
  concluido: "Concluído",
  andamento: "Em andamento",
  pendente: "Pendente",
};

export default function Dashboard() {
  const { data: summary, isLoading: isSummaryLoading } = useGetCampaignsSummary({ query: { refetchInterval: 15000 } });
  const { data: campaigns, isLoading: isCampaignsLoading } = useListCampaigns({ query: { refetchInterval: 15000 } });

  const recentCampaigns = campaigns
    ? [...campaigns].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 5)
    : [];

  const statusCounts = campaigns
    ? campaigns.reduce(
        (acc, c) => {
          const s = getCampaignStatus(c as any);
          acc[s] = (acc[s] || 0) + 1;
          return acc;
        },
        {} as Record<string, number>
      )
    : {};

  const totalFinished = statusCounts["finalizado"] || 0;

  const pieData = [
    { name: "Finalizado", value: statusCounts["finalizado"] || 0, color: STATUS_COLORS.finalizado },
    { name: "Concluído", value: statusCounts["concluido"] || 0, color: STATUS_COLORS.concluido },
    { name: "Em andamento", value: statusCounts["andamento"] || 0, color: STATUS_COLORS.andamento },
    { name: "Pendente", value: statusCounts["pendente"] || 0, color: STATUS_COLORS.pendente },
  ].filter((d) => d.value > 0);

  const replyChartData = campaigns
    ? [...campaigns]
        .filter((c) => (c as any).repliesCount > 0)
        .sort((a, b) => (b as any).repliesCount - (a as any).repliesCount)
        .slice(0, 6)
        .map((c) => ({
          name: c.name.length > 16 ? c.name.slice(0, 14) + "…" : c.name,
          retornos: (c as any).repliesCount,
          enviados: c.sentCount,
        }))
    : [];

  const progressChartData = campaigns
    ? [...campaigns]
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, 6)
        .map((c) => ({
          name: c.name.length > 14 ? c.name.slice(0, 12) + "…" : c.name,
          enviados: c.sentCount,
          pendentes: c.pendingCount ?? 0,
        }))
        .reverse()
    : [];

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
          <p className="text-muted-foreground mt-1">Visão geral dos seus disparos de WhatsApp.</p>
        </div>
        <Link href="/campanhas/nova">
          <Button>Nova Campanha</Button>
        </Link>
      </div>

      {/* Summary cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <Card className="hover-elevate transition-all">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Campanhas</CardTitle>
            <MessageCircle className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{isSummaryLoading ? "..." : summary?.totalCampaigns || 0}</div>
          </CardContent>
        </Card>

        <Card className="hover-elevate transition-all">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Contatos</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{isSummaryLoading ? "..." : summary?.totalContacts || 0}</div>
          </CardContent>
        </Card>

        <Card className="hover-elevate transition-all">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Mensagens Enviadas</CardTitle>
            <CheckCircle2 className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{isSummaryLoading ? "..." : summary?.totalSent || 0}</div>
          </CardContent>
        </Card>

        <Card className="hover-elevate transition-all">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Pendentes</CardTitle>
            <Clock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{isSummaryLoading ? "..." : summary?.totalPending || 0}</div>
          </CardContent>
        </Card>

        <Card className="hover-elevate transition-all border-green-200 dark:border-green-800">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Respostas</CardTitle>
            <Reply className="h-4 w-4 text-green-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">
              {isSummaryLoading ? "..." : (summary as any)?.totalReplies || 0}
            </div>
          </CardContent>
        </Card>

        <Card className="hover-elevate transition-all border-purple-200 dark:border-purple-800">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Finalizadas</CardTitle>
            <Flag className="h-4 w-4 text-purple-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-purple-600">
              {isCampaignsLoading ? "..." : totalFinished}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Charts row */}
      {!isCampaignsLoading && campaigns && campaigns.length > 0 && (
        <div className="grid gap-4 lg:grid-cols-3">
          {/* Status distribution pie */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Campanhas por Status</CardTitle>
              <CardDescription>Distribuição atual de todas as campanhas</CardDescription>
            </CardHeader>
            <CardContent>
              {pieData.length === 0 ? (
                <div className="h-48 flex items-center justify-center text-sm text-muted-foreground">Sem dados</div>
              ) : (
                <ResponsiveContainer width="100%" height={200}>
                  <PieChart>
                    <Pie
                      data={pieData}
                      cx="50%"
                      cy="50%"
                      innerRadius={50}
                      outerRadius={75}
                      paddingAngle={3}
                      dataKey="value"
                    >
                      {pieData.map((entry, index) => (
                        <Cell key={index} fill={entry.color} />
                      ))}
                    </Pie>
                    <Tooltip formatter={(value: any) => [`${value} campanha(s)`, ""]} />
                    <Legend
                      formatter={(value) => <span className="text-xs">{value}</span>}
                      iconSize={10}
                    />
                  </PieChart>
                </ResponsiveContainer>
              )}
              <div className="grid grid-cols-2 gap-2 mt-2">
                {Object.entries(statusCounts).map(([status, count]) => (
                  <div key={status} className="flex items-center gap-1.5">
                    <div
                      className="w-2.5 h-2.5 rounded-full shrink-0"
                      style={{ backgroundColor: STATUS_COLORS[status as keyof typeof STATUS_COLORS] }}
                    />
                    <span className="text-xs text-muted-foreground">
                      {STATUS_LABELS[status as keyof typeof STATUS_LABELS]}: <strong>{count}</strong>
                    </span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Sent vs Pending per campaign */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Enviados vs Pendentes</CardTitle>
              <CardDescription>Últimas 6 campanhas</CardDescription>
            </CardHeader>
            <CardContent>
              {progressChartData.length === 0 ? (
                <div className="h-48 flex items-center justify-center text-sm text-muted-foreground">Sem dados</div>
              ) : (
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={progressChartData} barSize={14} margin={{ top: 4, right: 4, left: -20, bottom: 40 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis
                      dataKey="name"
                      tick={{ fontSize: 10 }}
                      angle={-35}
                      textAnchor="end"
                      interval={0}
                    />
                    <YAxis tick={{ fontSize: 10 }} />
                    <Tooltip />
                    <Bar dataKey="enviados" name="Enviados" fill="#3b82f6" radius={[3, 3, 0, 0]} />
                    <Bar dataKey="pendentes" name="Pendentes" fill="#94a3b8" radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>

          {/* Replies per campaign */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Retornos por Campanha</CardTitle>
              <CardDescription>Top campanhas com mais respostas</CardDescription>
            </CardHeader>
            <CardContent>
              {replyChartData.length === 0 ? (
                <div className="h-48 flex items-center justify-center text-sm text-muted-foreground">
                  Nenhum retorno registrado ainda
                </div>
              ) : (
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={replyChartData} barSize={16} layout="vertical" margin={{ top: 4, right: 20, left: 4, bottom: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="hsl(var(--border))" />
                    <XAxis type="number" tick={{ fontSize: 10 }} />
                    <YAxis dataKey="name" type="category" tick={{ fontSize: 10 }} width={70} />
                    <Tooltip />
                    <Bar dataKey="retornos" name="Retornos" fill="#22c55e" radius={[0, 3, 3, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* Recent campaigns */}
      <Card>
        <CardHeader>
          <CardTitle>Campanhas Recentes</CardTitle>
          <CardDescription>Suas últimas 5 campanhas criadas.</CardDescription>
        </CardHeader>
        <CardContent>
          {isCampaignsLoading ? (
            <div className="text-center py-8 text-muted-foreground">Carregando campanhas...</div>
          ) : recentCampaigns.length === 0 ? (
            <div className="text-center py-12">
              <MessageCircle className="mx-auto h-12 w-12 text-muted-foreground/50 mb-4" />
              <h3 className="text-lg font-medium text-foreground mb-1">Nenhuma campanha encontrada</h3>
              <p className="text-muted-foreground mb-4">Você ainda não criou nenhuma campanha de disparo.</p>
              <Link href="/campanhas/nova">
                <Button variant="outline">Criar primeira campanha</Button>
              </Link>
            </div>
          ) : (
            <div className="space-y-3">
              {recentCampaigns.map((campaign) => {
                const progress = campaign.totalContacts > 0
                  ? Math.round((campaign.sentCount / campaign.totalContacts) * 100)
                  : 0;
                const status = getCampaignStatus(campaign as any);

                return (
                  <div key={campaign.id} className="flex items-center justify-between p-4 border rounded-lg hover:bg-muted/50 transition-colors gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Link href={`/campanhas/${campaign.id}`} className="font-medium text-foreground hover:underline truncate">
                          {campaign.name}
                        </Link>
                        <Badge
                          className={cn(
                            "shrink-0 text-xs border",
                            status === "finalizado" && "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400 border-purple-200 dark:border-purple-800",
                            status === "concluido" && "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400 border-green-200 dark:border-green-800",
                            status === "andamento" && "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400 border-blue-200 dark:border-blue-800",
                            status === "pendente" && "bg-muted text-muted-foreground border-border"
                          )}
                          variant="outline"
                        >
                          {status === "finalizado"
                            ? "Finalizado"
                            : status === "concluido"
                            ? "Concluído"
                            : status === "andamento"
                            ? `Em andamento ${progress}%`
                            : "Pendente"}
                        </Badge>
                      </div>
                      <div className="flex items-center text-xs text-muted-foreground mt-1 gap-3">
                        <span>{format(new Date(campaign.createdAt), "dd/MM/yyyy", { locale: ptBR })}</span>
                        <span>•</span>
                        <span>{campaign.sentCount} de {campaign.totalContacts} enviados</span>
                        {(campaign as any).repliesCount > 0 && (
                          <>
                            <span>•</span>
                            <span className="text-green-600 font-medium">{(campaign as any).repliesCount} retorno(s)</span>
                          </>
                        )}
                      </div>
                      {status !== "pendente" && (
                        <div className="w-full bg-muted rounded-full h-1.5 mt-2 overflow-hidden">
                          <div
                            className={cn(
                              "h-1.5 rounded-full transition-all duration-500",
                              status === "finalizado" ? "bg-purple-500" : status === "concluido" ? "bg-green-500" : "bg-blue-500"
                            )}
                            style={{ width: `${progress}%` }}
                          />
                        </div>
                      )}
                    </div>

                    <Link href={`/campanhas/${campaign.id}`} className="shrink-0">
                      <Button size="sm" variant="secondary">Abrir</Button>
                    </Link>
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
