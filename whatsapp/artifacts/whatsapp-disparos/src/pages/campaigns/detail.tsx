import { useState, useRef } from "react";
import { useRoute, Link } from "wouter";
import {
  useGetCampaign,
  useGetCampaignContacts,
  useMarkContactSent,
  useGetWhatsappStatus,
  sendWhatsappMessage,
  getGetCampaignQueryKey,
  getGetCampaignContactsQueryKey,
  getGetWhatsappStatusQueryKey,
} from "@workspace/api-client-react";
import { generateWhatsAppLink } from "@/lib/whatsapp";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { MessageSquare, Send, CheckCircle2, AlertCircle, Phone, Wifi, WifiOff, Loader2, RefreshCw, SendHorizonal, X, FlagOff, StopCircle } from "lucide-react";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { useToast } from "@/hooks/use-toast";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Contact } from "@workspace/api-client-react/src/generated/api.schemas";

const SEND_DELAY_MS = 20000;

export default function CampaignDetail() {
  const [, params] = useRoute("/campanhas/:id");
  const id = params?.id ? parseInt(params.id, 10) : 0;
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [sendingId, setSendingId] = useState<number | null>(null);
  const [isSendingAll, setIsSendingAll] = useState(false);
  const [sendAllProgress, setSendAllProgress] = useState<{ done: number; total: number } | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  const cancelRef = useRef(false);
  const [showFinishDialog, setShowFinishDialog] = useState(false);

  const finishMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/campaigns/${id}/finish`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Erro ao finalizar campanha.");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: getGetCampaignContactsQueryKey(id) });
      queryClient.invalidateQueries({ queryKey: getGetCampaignQueryKey(id) });
      setShowFinishDialog(false);
      toast({ description: "Campanha finalizada. Não será possível reabri-la." });
    },
    onError: (err: Error) => {
      toast({ title: "Erro", description: err.message, variant: "destructive" });
    },
  });

  const { data: campaign, isLoading: isCampaignLoading } = useGetCampaign(id, {
    query: { enabled: !!id, queryKey: getGetCampaignQueryKey(id), refetchInterval: 15000 },
  });
  const { data: contacts, isLoading: isContactsLoading, refetch: refetchContacts } = useGetCampaignContacts(id, {
    query: { enabled: !!id, queryKey: getGetCampaignContactsQueryKey(id) },
  });
  const { data: waStatus } = useGetWhatsappStatus({
    query: { queryKey: getGetWhatsappStatusQueryKey(), refetchInterval: 10000 },
  });

  const markSent = useMarkContactSent();

  const isWaConnected = waStatus?.connected ?? false;
  const [previewContact, setPreviewContact] = useState<Contact | null>(null);

  const pendingContacts = contacts?.filter((c) => c.status !== "sent") ?? [];
  const hasPending = pendingContacts.length > 0;

  const invalidateContacts = () => {
    queryClient.invalidateQueries({ queryKey: getGetCampaignContactsQueryKey(id) });
    queryClient.invalidateQueries({ queryKey: getGetCampaignQueryKey(id) });
  };

  // Send a single contact via WhatsApp (works for both send and resend)
  // Returns { ok, error } to surface the real error to the user
  const sendContact = async (contact: Contact): Promise<{ ok: boolean; error?: string }> => {
    if (isWaConnected) {
      try {
        const result = await sendWhatsappMessage({
          phone: contact.phone,
          message: contact.message,
          imageUrl: campaign?.templateImageUrl ?? undefined,
          campaignId: id,
          contactId: contact.id,
        });
        if (result.success) return { ok: true };
        return { ok: false, error: result.error ?? "Erro desconhecido" };
      } catch (err: any) {
        // ApiError carries the server message
        const msg = err?.data?.error ?? err?.message ?? "Erro ao conectar com a API";
        return { ok: false, error: msg };
      }
    } else {
      // Manual fallback
      const url = generateWhatsAppLink(contact.phone, contact.message);
      window.open(url, "_blank");
      return new Promise((resolve) => {
        markSent.mutate(
          { id, contactId: contact.id },
          { onSuccess: () => resolve({ ok: true }), onError: () => resolve({ ok: false }) }
        );
      });
    }
  };

  const handleSend = async (contact: Contact) => {
    setSendingId(contact.id);
    const { ok, error } = await sendContact(contact);
    setSendingId(null);
    if (ok) {
      invalidateContacts();
      toast({ description: `Mensagem enviada para ${contact.name}` });
    } else {
      toast({
        title: `Falha ao enviar para ${contact.name}`,
        description: error ?? "Verifique se o WhatsApp está conectado.",
        variant: "destructive",
      });
    }
  };

  const handleSendAll = async () => {
    if (!contacts) return;
    const targets = contacts.filter((c) => c.status !== "sent");
    if (targets.length === 0) return;

    cancelRef.current = false;
    setIsSendingAll(true);
    setSendAllProgress({ done: 0, total: targets.length });

    let successCount = 0;

    for (let i = 0; i < targets.length; i++) {
      if (cancelRef.current) break;

      const contact = targets[i];
      setSendingId(contact.id);

      const { ok, error } = await sendContact(contact);
      if (ok) {
        successCount++;
      } else if (error) {
        toast({
          title: `Falha: ${contact.name}`,
          description: error,
          variant: "destructive",
        });
      }

      // Refresh list after each send so status updates live
      invalidateContacts();
      setSendAllProgress({ done: i + 1, total: targets.length });

      // Wait before the next message (skip after last)
      if (i < targets.length - 1 && !cancelRef.current) {
        const totalSecs = Math.round(SEND_DELAY_MS / 1000);
        setCountdown(totalSecs);
        await new Promise<void>((resolve) => {
          let remaining = totalSecs;
          const ticker = setInterval(() => {
            remaining -= 1;
            if (remaining <= 0 || cancelRef.current) {
              clearInterval(ticker);
              setCountdown(null);
              resolve();
            } else {
              setCountdown(remaining);
            }
          }, 1000);
        });
      }
    }

    setSendingId(null);
    setIsSendingAll(false);
    setSendAllProgress(null);
    setCountdown(null);
    cancelRef.current = false;
    invalidateContacts();

    if (!cancelRef.current) {
      toast({
        description: `Disparo concluído! ${successCount} de ${targets.length} mensagens enviadas.`,
      });
    } else {
      toast({ description: `Disparo cancelado. ${successCount} mensagens enviadas.` });
    }
  };

  const handleCancelSendAll = () => {
    cancelRef.current = true;
  };

  if (isCampaignLoading) return <div className="p-8 text-center">Carregando detalhes...</div>;
  if (!campaign) return <div className="p-8 text-center text-destructive">Campanha não encontrada</div>;

  const isFinished = campaign.status === "finished";

  const progress = campaign.totalContacts > 0
    ? Math.round((campaign.sentCount / campaign.totalContacts) * 100)
    : 0;

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex flex-col md:flex-row md:items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-3xl font-bold tracking-tight">{campaign.name}</h1>
            {isFinished && (
              <Badge variant="secondary" className="bg-gray-100 text-gray-600 border-gray-300 gap-1 text-sm">
                <FlagOff className="w-3.5 h-3.5" />
                Finalizada
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-3 mt-2 text-muted-foreground text-sm">
            <span className="flex items-center gap-1.5 bg-muted px-2 py-1 rounded-md">
              <MessageSquare className="w-3.5 h-3.5" /> {campaign.templateName}
            </span>
            <span>Criada em {format(new Date(campaign.createdAt), "dd MMM yyyy", { locale: ptBR })}</span>
            {isFinished && campaign.finishedAt && (
              <span className="text-gray-500">
                · Finalizada em {format(new Date(campaign.finishedAt), "dd/MM/yyyy", { locale: ptBR })}
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0 flex-wrap">
          {isWaConnected ? (
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-green-50 border border-green-200 text-green-700 text-sm font-medium">
              <Wifi className="w-4 h-4" />
              Envio automático ativo
            </div>
          ) : (
            <Link href="/configuracoes">
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-muted border text-muted-foreground text-sm cursor-pointer hover:bg-accent transition-colors">
                <WifiOff className="w-4 h-4" />
                Vincular WhatsApp
              </div>
            </Link>
          )}

          {!isFinished && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowFinishDialog(true)}
              className="gap-1.5 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              <FlagOff className="w-3.5 h-3.5" />
              Finalizar Campanha
            </Button>
          )}
        </div>
      </div>

      {isFinished && (
        <div className="flex items-start gap-2 p-3 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-700">
          <FlagOff className="w-4 h-4 mt-0.5 shrink-0 text-gray-500" />
          <span>Esta campanha foi finalizada e não pode mais ser reaberta. Envios estão desabilitados.</span>
        </div>
      )}

      {!isFinished && !isWaConnected && (
        <div className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-800">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>
            Modo manual: o botão "Enviar" abre o WhatsApp Web com a mensagem pronta.{" "}
            <Link href="/configuracoes" className="underline font-medium">
              Vincule seu WhatsApp
            </Link>{" "}
            para disparar automaticamente sem abrir o navegador.
          </span>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Progresso</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{progress}%</div>
            <div className="w-full bg-muted rounded-full h-2 mt-3 overflow-hidden">
              <div className="bg-primary h-2 rounded-full transition-all duration-500" style={{ width: `${progress}%` }} />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Enviados</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-primary">{campaign.sentCount}</div>
            <p className="text-xs text-muted-foreground mt-1">Mensagens entregues</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Pendentes</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{campaign.pendingCount}</div>
            <p className="text-xs text-muted-foreground mt-1">Aguardando envio</p>
          </CardContent>
        </Card>
        <Card className="border-green-200 dark:border-green-800">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Retornos</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-green-600">{campaign.repliesCount ?? 0}</div>
            <p className="text-xs text-muted-foreground mt-1">Respostas recebidas</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div>
            <CardTitle>Lista de Contatos</CardTitle>
            <CardDescription className="mt-1">
              {isWaConnected
                ? "Clique em Enviar para disparar automaticamente pelo WhatsApp conectado."
                : "Clique em Enviar para abrir o WhatsApp Web com a mensagem pronta."}
            </CardDescription>
          </div>

          {/* Send All / Cancel */}
          {isWaConnected && !isFinished && (
            isSendingAll ? (
              <div className="flex items-center gap-3 shrink-0">
                <div className="text-sm text-muted-foreground flex items-center gap-1.5">
                  {countdown !== null ? (
                    <>
                      <span className="inline-block w-3.5 h-3.5 rounded-full border-2 border-amber-400 border-t-transparent animate-spin" />
                      <span className="text-amber-600 font-medium">Aguardando {countdown}s...</span>
                    </>
                  ) : (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      {sendAllProgress ? `Enviando ${sendAllProgress.done}/${sendAllProgress.total}` : "..."}
                    </>
                  )}
                </div>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={handleCancelSendAll}
                  className="gap-1.5 h-8"
                >
                  <StopCircle className="w-3.5 h-3.5" />
                  Parar Envio
                </Button>
              </div>
            ) : (
              hasPending && (
                <Button size="sm" onClick={handleSendAll} className="gap-1.5 shrink-0 h-8">
                  <SendHorizonal className="w-3.5 h-3.5" />
                  Enviar Todos ({pendingContacts.length})
                </Button>
              )
            )
          )}
        </CardHeader>

        {/* Send-all progress bar */}
        {isSendingAll && sendAllProgress && (
          <div className="px-6 pb-3">
            <div className="w-full bg-muted rounded-full h-1.5 overflow-hidden">
              <div
                className="bg-primary h-1.5 rounded-full transition-all duration-500"
                style={{ width: `${(sendAllProgress.done / sendAllProgress.total) * 100}%` }}
              />
            </div>
          </div>
        )}

        <CardContent className="p-0">
          {isContactsLoading ? (
            <div className="p-8 text-center text-muted-foreground">Carregando contatos...</div>
          ) : contacts?.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground">Nenhum contato nesta campanha.</div>
          ) : (
            <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-6">Nome</TableHead>
                  <TableHead>Telefone</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Mensagem</TableHead>
                  <TableHead className="text-right pr-6">Ação</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {contacts?.map((contact) => {
                  const isSent = contact.status === "sent";
                  const isThisSending = sendingId === contact.id;
                  const isAnyBusy = sendingId !== null || isSendingAll || isFinished;

                  return (
                    <TableRow key={contact.id} className={isSent ? "bg-muted/30" : ""}>
                      <TableCell className="pl-6 font-medium">{contact.name}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1.5 text-muted-foreground">
                          <Phone className="w-3.5 h-3.5" />
                          {contact.phone}
                        </div>
                      </TableCell>
                      <TableCell>
                        {isSent ? (
                          <Badge variant="secondary" className="bg-primary/10 text-primary border-primary/20">
                            <CheckCircle2 className="w-3 h-3 mr-1" />
                            Enviado
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="text-muted-foreground">
                            Pendente
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="link"
                          size="sm"
                          onClick={() => setPreviewContact(contact)}
                          className="h-8 px-2 text-muted-foreground"
                        >
                          Ver prévia
                        </Button>
                      </TableCell>
                      <TableCell className="text-right pr-6">
                        {isSent ? (
                          // Resend button for already-sent contacts
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleSend(contact)}
                            disabled={isAnyBusy}
                            className="gap-1.5 h-8 text-muted-foreground"
                          >
                            {isThisSending ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              <RefreshCw className="w-3.5 h-3.5" />
                            )}
                            Reenviar
                          </Button>
                        ) : (
                          // Send button for pending contacts
                          <Button
                            size="sm"
                            onClick={() => handleSend(contact)}
                            disabled={isAnyBusy}
                            className="gap-1.5 h-8"
                          >
                            {isThisSending ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              <Send className="w-3.5 h-3.5" />
                            )}
                            {isWaConnected ? "Enviar" : "Abrir WhatsApp"}
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Preview dialog */}
      <Dialog open={!!previewContact} onOpenChange={(open) => !open && setPreviewContact(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Prévia da Mensagem</DialogTitle>
          </DialogHeader>
          <div className="mt-4">
            <div className="text-sm font-medium mb-2 text-muted-foreground">
              Para: {previewContact?.name} ({previewContact?.phone})
            </div>
            <div className="bg-muted/50 p-4 rounded-lg whitespace-pre-wrap text-sm border font-mono">
              {previewContact?.message}
            </div>
            {!isFinished && (
              <div className="mt-6 flex justify-end">
                <Button
                  onClick={() => {
                    if (previewContact) handleSend(previewContact);
                    setPreviewContact(null);
                  }}
                >
                  <Send className="w-4 h-4 mr-2" />
                  {isWaConnected ? "Enviar agora" : "Abrir WhatsApp"}
                </Button>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Finalize campaign confirmation dialog */}
      <Dialog open={showFinishDialog} onOpenChange={setShowFinishDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FlagOff className="w-5 h-5 text-destructive" />
              Finalizar campanha
            </DialogTitle>
          </DialogHeader>
          <div className="text-sm text-muted-foreground space-y-2">
            <p>
              Tem certeza que deseja finalizar a campanha <strong>{campaign.name}</strong>?
            </p>
            <p className="text-destructive font-medium">
              Esta ação é irreversível. Após finalizar, nenhuma mensagem poderá ser enviada por esta campanha.
            </p>
          </div>
          <DialogFooter className="mt-4">
            <Button variant="outline" onClick={() => setShowFinishDialog(false)}>
              Cancelar
            </Button>
            <Button
              variant="destructive"
              onClick={() => finishMutation.mutate()}
              disabled={finishMutation.isPending}
              className="gap-2"
            >
              {finishMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
              Finalizar campanha
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
