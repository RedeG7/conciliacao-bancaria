import { useEffect, useRef, useState } from "react";
import {
  useGetWhatsappStatus,
  useConnectWhatsapp,
  useDisconnectWhatsapp,
  getGetWhatsappStatusQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Smartphone, Wifi, WifiOff, RefreshCw, LogOut, CheckCircle2, AlertCircle, Loader2, RotateCcw } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

type WaState = "idle" | "connecting" | "qr_ready" | "connected" | "disconnected";

interface WaStatus {
  state: WaState;
  connected: boolean;
  phone: string | null;
  name: string | null;
  qrCode: string | null;
}

export default function Configuracoes() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [liveStatus, setLiveStatus] = useState<WaStatus | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  const { data: status } = useGetWhatsappStatus({
    query: { queryKey: getGetWhatsappStatusQueryKey(), refetchInterval: 10000 },
  });

  const connectMutation = useConnectWhatsapp();
  const disconnectMutation = useDisconnectWhatsapp();

  // SSE connection for real-time QR and status updates
  useEffect(() => {
    const baseUrl = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";
    const apiBase = `${baseUrl}/api/whatsapp/qr-stream`.replace(/\/+/, "/").replace(/^\/\//, "/");
    const url = `${window.location.origin}${apiBase}`;

    const es = new EventSource(url);
    eventSourceRef.current = es;

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as WaStatus;
        setLiveStatus(data);
        // Invalidate the query so other components pick up the change
        queryClient.invalidateQueries({ queryKey: getGetWhatsappStatusQueryKey() });
      } catch {}
    };

    es.onerror = () => {
      // SSE will auto-retry on error — no action needed
    };

    return () => {
      es.close();
    };
  }, [queryClient]);

  const currentStatus: WaStatus | null = liveStatus ?? (status as WaStatus | undefined) ?? null;

  const handleConnect = async () => {
    connectMutation.mutate(undefined, {
      onError: () => toast({ title: "Erro", description: "Falha ao iniciar conexão", variant: "destructive" }),
    });
  };

  const handleRestart = async () => {
    disconnectMutation.mutate(undefined, {
      onSuccess: () => {
        setLiveStatus(null);
        queryClient.invalidateQueries({ queryKey: getGetWhatsappStatusQueryKey() });
        setTimeout(() => {
          connectMutation.mutate(undefined, {
            onError: () => toast({ title: "Erro", description: "Falha ao reconectar", variant: "destructive" }),
          });
        }, 800);
      },
      onError: () => toast({ title: "Erro", description: "Falha ao reiniciar conexão", variant: "destructive" }),
    });
  };

  const handleDisconnect = async () => {
    disconnectMutation.mutate(undefined, {
      onSuccess: () => {
        setLiveStatus(null);
        toast({ description: "WhatsApp desconectado com sucesso." });
        queryClient.invalidateQueries({ queryKey: getGetWhatsappStatusQueryKey() });
      },
      onError: () => toast({ title: "Erro", description: "Falha ao desconectar", variant: "destructive" }),
    });
  };

  const stateLabel: Record<WaState, string> = {
    idle: "Desconectado",
    connecting: "Conectando...",
    qr_ready: "Aguardando leitura do QR",
    connected: "Conectado",
    disconnected: "Desconectado",
  };

  const stateBadge: Record<WaState, "default" | "secondary" | "destructive"> = {
    idle: "secondary",
    connecting: "secondary",
    qr_ready: "secondary",
    connected: "default",
    disconnected: "destructive",
  };

  const state = currentStatus?.state ?? "idle";
  const isConnected = currentStatus?.connected ?? false;
  const isConnecting = state === "connecting" || state === "qr_ready";
  const hasQR = !!currentStatus?.qrCode;

  return (
    <div className="space-y-6 animate-in fade-in duration-500 max-w-2xl">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Configurações</h1>
        <p className="text-muted-foreground mt-1">Vincule seu WhatsApp para enviar mensagens automaticamente pela plataforma.</p>
      </div>

      <Card>
        <CardHeader className="pb-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className={`w-10 h-10 rounded-full flex items-center justify-center ${isConnected ? "bg-green-100" : "bg-muted"}`}>
                <Smartphone className={`w-5 h-5 ${isConnected ? "text-green-600" : "text-muted-foreground"}`} />
              </div>
              <div>
                <CardTitle className="text-base">WhatsApp</CardTitle>
                <CardDescription>Conexão via WhatsApp Web</CardDescription>
              </div>
            </div>
            <Badge variant={stateBadge[state]} className={isConnected ? "bg-green-100 text-green-700 border-green-200" : ""}>
              {stateLabel[state]}
            </Badge>
          </div>
        </CardHeader>

        <Separator />

        <CardContent className="pt-6">
          {/* CONNECTED STATE */}
          {isConnected && currentStatus && (
            <div className="space-y-4">
              <div className="flex items-center gap-3 p-4 bg-green-50 border border-green-200 rounded-lg">
                <CheckCircle2 className="w-5 h-5 text-green-600 shrink-0" />
                <div>
                  <p className="font-medium text-green-800">WhatsApp conectado com sucesso</p>
                  {currentStatus.phone && (
                    <p className="text-sm text-green-700 mt-0.5">
                      Número: +{currentStatus.phone}
                      {currentStatus.name && ` — ${currentStatus.name}`}
                    </p>
                  )}
                </div>
              </div>

              <div className="bg-muted/40 rounded-lg p-4 space-y-2 text-sm text-muted-foreground">
                <p className="font-medium text-foreground">Como funciona o envio automático:</p>
                <ul className="space-y-1 list-disc list-inside">
                  <li>Nas campanhas, clique em "Enviar" em cada contato</li>
                  <li>A mensagem será enviada automaticamente pelo WhatsApp conectado</li>
                  <li>O status do contato muda para "Enviado" em tempo real</li>
                </ul>
              </div>

              <Button
                variant="destructive"
                onClick={handleDisconnect}
                disabled={disconnectMutation.isPending}
                className="gap-2"
              >
                {disconnectMutation.isPending ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <LogOut className="w-4 h-4" />
                )}
                Desconectar WhatsApp
              </Button>
            </div>
          )}

          {/* QR CODE STATE */}
          {!isConnected && hasQR && (
            <div className="space-y-4">
              <div className="flex items-center gap-2 p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-800">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>Escaneie o QR code abaixo com seu WhatsApp para conectar</span>
              </div>

              <div className="flex flex-col items-center gap-4">
                <div className="border-4 border-green-500 rounded-2xl p-2 shadow-lg bg-white">
                  <img
                    src={currentStatus!.qrCode!}
                    alt="QR Code do WhatsApp"
                    className="w-64 h-64 rounded-lg"
                  />
                </div>
                <div className="text-center space-y-1">
                  <p className="text-sm font-medium">Como escanear:</p>
                  <ol className="text-sm text-muted-foreground text-left space-y-1 list-decimal list-inside">
                    <li>Abra o WhatsApp no seu celular</li>
                    <li>Toque em "Mais opções" (3 pontos) ou "Configurações"</li>
                    <li>Toque em "Dispositivos conectados"</li>
                    <li>Toque em "Conectar dispositivo"</li>
                    <li>Aponte a câmera para o QR code acima</li>
                  </ol>
                </div>
                <p className="text-xs text-muted-foreground">O QR code atualiza automaticamente. Aguarde...</p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={handleRestart}
                disabled={disconnectMutation.isPending || connectMutation.isPending}
                className="gap-2"
              >
                <RotateCcw className="w-4 h-4" />
                Gerar Novo QR Code
              </Button>
            </div>
          )}

          {/* CONNECTING STATE (no QR yet) */}
          {!isConnected && !hasQR && state === "connecting" && (
            <div className="flex flex-col items-center gap-4 py-8">
              <Loader2 className="w-8 h-8 animate-spin text-primary" />
              <div className="text-center">
                <p className="font-medium">Iniciando conexão...</p>
                <p className="text-sm text-muted-foreground mt-1">O QR code aparecerá em alguns segundos.</p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={handleRestart}
                disabled={disconnectMutation.isPending || connectMutation.isPending}
                className="gap-2 mt-2"
              >
                <RotateCcw className="w-4 h-4" />
                Reiniciar Conexão
              </Button>
            </div>
          )}

          {/* IDLE / DISCONNECTED STATE */}
          {!isConnected && !isConnecting && (
            <div className="space-y-4">
              <div className="flex flex-col items-center gap-4 py-6 text-center">
                <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center">
                  <WifiOff className="w-8 h-8 text-muted-foreground" />
                </div>
                <div>
                  <p className="font-medium text-foreground">WhatsApp não vinculado</p>
                  <p className="text-sm text-muted-foreground mt-1">
                    Conecte seu WhatsApp para enviar mensagens diretamente pela plataforma,<br />
                    sem precisar abrir o celular a cada envio.
                  </p>
                </div>
              </div>

              <Button
                onClick={handleConnect}
                disabled={connectMutation.isPending}
                className="w-full gap-2"
              >
                {connectMutation.isPending ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Wifi className="w-4 h-4" />
                )}
                Vincular WhatsApp
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* INFO CARD */}
      <Card className="bg-muted/30 border-dashed">
        <CardContent className="pt-6">
          <div className="flex gap-3">
            <AlertCircle className="w-5 h-5 text-muted-foreground shrink-0 mt-0.5" />
            <div className="text-sm text-muted-foreground space-y-1">
              <p className="font-medium text-foreground">Sobre a conexão</p>
              <p>Esta integração usa o protocolo do WhatsApp Web. Seu celular precisa estar com o WhatsApp instalado e com acesso à internet para receber e enviar as mensagens.</p>
              <p className="mt-2">A sessão fica salva no servidor — você não precisa escanear o QR toda vez que acessar a plataforma.</p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
