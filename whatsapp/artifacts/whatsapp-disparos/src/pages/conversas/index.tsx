import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { format, isToday, isYesterday } from "date-fns";
import { ptBR } from "date-fns/locale";
import {
  Send, MessageSquare, Phone, Loader2, Search, RefreshCw,
  Paperclip, Smile, Plus, X, UserPlus,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

interface Conversation {
  id: number;
  phone: string;
  contactName: string | null;
  lastMessageBody: string | null;
  lastMessageAt: string;
  unreadCount: number;
  campaignId: number | null;
}

interface Message {
  id: number;
  conversationId: number;
  body: string;
  direction: "in" | "out";
  timestamp: string;
}

interface Contact {
  id: number;
  name: string;
  phone: string;
}

function playNotificationSound() {
  try {
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const playTone = (freq: number, startTime: number, duration: number, vol = 0.25) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(vol, startTime);
      gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
      osc.start(startTime);
      osc.stop(startTime + duration);
    };
    const now = ctx.currentTime;
    playTone(880, now, 0.12);
    playTone(1108, now + 0.13, 0.18);
  } catch {}
}

async function apiFetch(path: string, opts: RequestInit = {}) {
  const res = await fetch(path, { credentials: "include", ...opts });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return res.status === 204 ? null : res.json();
}

function formatPhone(phone: string) {
  const d = phone.replace(/\D/g, "");
  if (d.length === 13 && d.startsWith("55")) {
    const local = d.slice(2);
    return `(${local.slice(0, 2)}) ${local.slice(2, 7)}-${local.slice(7)}`;
  }
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  return phone;
}

function formatTime(iso: string) {
  const date = new Date(iso);
  if (isToday(date)) return format(date, "HH:mm");
  if (isYesterday(date)) return "Ontem";
  return format(date, "dd/MM/yyyy");
}

function formatMsgTime(iso: string) {
  return format(new Date(iso), "HH:mm");
}

const EMOJI_GROUPS = [
  {
    label: "Sorrisos",
    emojis: ["😀","😃","😄","😁","😆","😅","🤣","😂","🙂","🙃","😉","😊","😇","🥰","😍","🤩","😘","😗","😚","😙","😋","😛","😜","🤪","😝","🤑","🤗","🤭","🤫","🤔","🤐","🤨","😐","😑","😶","😏","😒","🙄","😬","🤥","😌","😔","😪","🤤","😴","😷","🤒","🤕","🤢","🤧","🥵","🥶","🥴","😵","🤯","🤠","🥳","😎","🤓","🧐","😕","😟","🙁","😮","😯","😲","😳","🥺","😦","😧","😨","😰","😥","😢","😭","😱","😖","😣","😞","😓","😩","😫","🥱","😤","😡","😠","🤬","😈","👿","💀","☠️","💩","🤡","👹","👺","👻","👽","👾","🤖"],
  },
  {
    label: "Gestos",
    emojis: ["👋","🤚","✋","🖖","🤙","👌","🤌","✌️","🤞","🤟","🤘","👈","👉","👆","👇","☝️","👍","👎","✊","👊","🤛","🤜","👏","🙌","👐","🤲","🤝","🙏","💪","🦾","🖐️","🤏"],
  },
  {
    label: "Corações",
    emojis: ["❤️","🧡","💛","💚","💙","💜","🖤","🤍","🤎","💔","❣️","💕","💞","💓","💗","💖","💘","💝","💟","☮️","✝️","☯️","🔥","💯","💢","💥","💫","💦","💨","🕳️","💬","💭","💤"],
  },
  {
    label: "Celebração",
    emojis: ["🎉","🎊","🎈","🎁","🎀","🏆","🥇","🥈","🥉","🎯","🎮","🎲","🎵","🎶","🎸","🎹","🎺","🎻","🥁","🎤","🎧","🎷","🪗","🎙️","📣","🔔","🔕","📯","🎖️","🏅"],
  },
  {
    label: "Natureza",
    emojis: ["🌸","🌹","🌺","🌻","🌼","🌷","🌱","🌿","🍀","🍃","🌲","🌳","🌴","🌵","🍄","🌾","💐","🪴","🌍","🌎","🌏","🌕","🌙","⭐","🌟","💫","✨","☀️","🌈","⛅","🌊","🔥","🍁","🍂","🍃"],
  },
];

function EmojiPicker({ onSelect }: { onSelect: (e: string) => void }) {
  const [activeGroup, setActiveGroup] = useState(0);
  return (
    <div className="w-72 p-2">
      <div className="flex gap-1 mb-2 border-b pb-2">
        {EMOJI_GROUPS.map((g, i) => (
          <button
            key={g.label}
            onClick={() => setActiveGroup(i)}
            className={cn(
              "flex-1 text-xs py-1 rounded transition-colors",
              activeGroup === i ? "bg-muted font-medium" : "hover:bg-muted/50 text-muted-foreground"
            )}
          >
            {g.emojis[0]}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-8 gap-0.5 max-h-52 overflow-y-auto">
        {EMOJI_GROUPS[activeGroup].emojis.map((emoji) => (
          <button
            key={emoji}
            onClick={() => onSelect(emoji)}
            className="text-xl p-1 rounded hover:bg-muted transition-colors leading-none"
          >
            {emoji}
          </button>
        ))}
      </div>
    </div>
  );
}

function renderMessageBody(body: string) {
  if (body.startsWith("[🎭 Figurinha]")) {
    return <span className="text-2xl">🎭 <span className="text-sm italic text-muted-foreground">Figurinha</span></span>;
  }
  if (body.startsWith("[📷 Imagem")) {
    return <span className="flex items-center gap-1.5">📷 <span className="text-sm italic">{body.replace("[📷 Imagem", "").replace("]", "").replace(": ", "") || "Imagem"}</span></span>;
  }
  if (body.startsWith("[🎥 Vídeo")) {
    return <span className="flex items-center gap-1.5">🎥 <span className="text-sm italic">{body.replace("[🎥 Vídeo", "").replace("]", "").replace(": ", "") || "Vídeo"}</span></span>;
  }
  if (body.startsWith("[📎 Documento")) {
    const name = body.replace(/\[📎 Documento:?\s?/, "").replace("]", "") || "Documento";
    return <span className="flex items-center gap-1.5">📎 <span className="text-sm underline">{name}</span></span>;
  }
  if (body.startsWith("[🎙️ Áudio]")) {
    return <span className="flex items-center gap-1.5">🎙️ <span className="text-sm italic">Áudio</span></span>;
  }
  if (body.startsWith("[mídia]")) {
    return <span className="text-sm italic text-muted-foreground">Mídia recebida</span>;
  }
  return <p className="whitespace-pre-wrap break-words leading-relaxed">{body}</p>;
}

export default function ConversasPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [text, setText] = useState("");
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [newConvOpen, setNewConvOpen] = useState(false);
  const [contactSearch, setContactSearch] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const prevTotalUnread = useRef<number>(0);
  const isFirstLoad = useRef(true);

  function autoResizeTextarea() {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 144) + "px";
  }

  const { data: conversations = [], isLoading: convsLoading, refetch: refetchConvs } = useQuery<Conversation[]>({
    queryKey: ["conversations"],
    queryFn: async () => {
      const res = await fetch("/api/conversations", { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    refetchInterval: 10000,
  });

  const { data: messages = [], isLoading: msgsLoading } = useQuery<Message[]>({
    queryKey: ["messages", selectedId],
    queryFn: () => selectedId ? apiFetch(`/api/conversations/${selectedId}/messages`) : [],
    enabled: !!selectedId,
    refetchInterval: 5000,
  });

  const { data: allContacts = [] } = useQuery<Contact[]>({
    queryKey: ["global-contacts"],
    queryFn: () => apiFetch("/api/contacts"),
    enabled: newConvOpen,
  });

  // Play notification sound when unread count increases
  useEffect(() => {
    if (!Array.isArray(conversations) || conversations.length === 0) return;
    const totalUnread = conversations.reduce((sum, c) => sum + (c.unreadCount ?? 0), 0);

    if (isFirstLoad.current) {
      isFirstLoad.current = false;
      prevTotalUnread.current = totalUnread;
      return;
    }

    if (totalUnread > prevTotalUnread.current) {
      playNotificationSound();
    }
    prevTotalUnread.current = totalUnread;
  }, [conversations]);

  useEffect(() => {
    if (selectedId) queryClient.invalidateQueries({ queryKey: ["conversations"] });
  }, [selectedId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const replyMutation = useMutation({
    mutationFn: ({ id, body }: { id: number; body: string }) =>
      apiFetch(`/api/conversations/${id}/reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["messages", selectedId] });
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
      setText("");
      setTimeout(() => autoResizeTextarea(), 0);
    },
    onError: (err: Error) => {
      toast({ title: "Erro ao enviar", description: err.message, variant: "destructive" });
    },
  });

  const fileMutation = useMutation({
    mutationFn: ({ id, file }: { id: number; file: File }) => {
      const formData = new FormData();
      formData.append("file", file);
      return fetch(`/api/conversations/${id}/send-file`, {
        method: "POST",
        credentials: "include",
        body: formData,
      }).then(async (res) => {
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || `HTTP ${res.status}`);
        }
        return res.json();
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["messages", selectedId] });
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
      toast({ title: "Arquivo enviado!" });
    },
    onError: (err: Error) => {
      toast({ title: "Erro ao enviar arquivo", description: err.message, variant: "destructive" });
    },
  });

  const startConvMutation = useMutation({
    mutationFn: ({ phone, contactName }: { phone: string; contactName?: string }) =>
      apiFetch("/api/conversations/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone, contactName }),
      }),
    onSuccess: (conv: Conversation) => {
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
      setSelectedId(conv.id);
      setNewConvOpen(false);
      setContactSearch("");
    },
    onError: (err: Error) => {
      toast({ title: "Erro ao iniciar conversa", description: err.message, variant: "destructive" });
    },
  });

  const handleSend = () => {
    if (!text.trim() || !selectedId) return;
    replyMutation.mutate({ id: selectedId, body: text.trim() });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !selectedId) return;
    fileMutation.mutate({ id: selectedId, file });
    e.target.value = "";
  };

  const filtered = Array.isArray(conversations)
    ? conversations.filter((c) => {
        if (!search) return true;
        const q = search.toLowerCase();
        return (c.contactName ?? "").toLowerCase().includes(q) || c.phone.includes(q);
      })
    : [];

  const filteredContacts = allContacts.filter((c) => {
    if (!contactSearch) return true;
    const q = contactSearch.toLowerCase();
    return c.name.toLowerCase().includes(q) || c.phone.includes(q);
  });

  const selected = Array.isArray(conversations) ? conversations.find((c) => c.id === selectedId) : undefined;

  return (
    <div className="flex h-[calc(100vh-4rem)] overflow-hidden rounded-xl border border-border bg-background animate-in fade-in duration-300">
      {/* Left panel */}
      <div className="w-80 shrink-0 flex flex-col border-r border-border">
        {/* Header */}
        <div className="px-4 pt-4 pb-3 border-b border-border space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold text-base">Conversas</h2>
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setNewConvOpen(true)} title="Nova conversa">
                <UserPlus className="w-4 h-4" />
              </Button>
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => refetchConvs()} title="Atualizar">
                <RefreshCw className="w-4 h-4" />
              </Button>
            </div>
          </div>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar conversa..."
              className="pl-9 h-8 text-sm"
            />
          </div>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto scrollbar-thin scrollbar-thumb-border scrollbar-track-transparent">
          {convsLoading ? (
            <div className="flex items-center justify-center h-32 text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin mr-2" /> Carregando...
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-48 text-muted-foreground gap-2 px-4 text-center">
              <MessageSquare className="w-8 h-8 opacity-40" />
              <p className="text-sm">Nenhuma conversa ainda.<br />As respostas dos clientes aparecem aqui.</p>
              <Button variant="outline" size="sm" className="gap-1.5 mt-1" onClick={() => setNewConvOpen(true)}>
                <Plus className="w-3.5 h-3.5" /> Nova conversa
              </Button>
            </div>
          ) : (
            filtered.map((conv) => (
              <button
                key={conv.id}
                className={cn(
                  "w-full text-left px-4 py-3 flex items-start gap-3 hover:bg-muted/50 transition-colors border-b border-border/50 last:border-0",
                  selectedId === conv.id && "bg-muted"
                )}
                onClick={() => setSelectedId(conv.id)}
              >
                <div className="w-10 h-10 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center shrink-0 text-green-700 dark:text-green-300 font-semibold text-sm uppercase">
                  {(conv.contactName?.[0] ?? conv.phone[0])}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-1">
                    <span className="font-medium text-sm truncate">
                      {conv.contactName || formatPhone(conv.phone)}
                    </span>
                    <span className="text-xs text-muted-foreground shrink-0">
                      {formatTime(conv.lastMessageAt)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-1 mt-0.5">
                    <p className="text-xs text-muted-foreground truncate">
                      {conv.lastMessageBody || "—"}
                    </p>
                    {conv.unreadCount > 0 && (
                      <Badge className="h-5 min-w-5 px-1.5 text-[10px] bg-green-600 hover:bg-green-600 shrink-0">
                        {conv.unreadCount}
                      </Badge>
                    )}
                  </div>
                </div>
              </button>
            ))
          )}
        </div>
      </div>

      {/* Right panel: chat */}
      {!selectedId ? (
        <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground gap-3">
          <div className="w-16 h-16 rounded-full bg-green-50 dark:bg-green-900/20 flex items-center justify-center">
            <MessageSquare className="w-8 h-8 text-green-600" />
          </div>
          <p className="text-sm">Selecione uma conversa para começar</p>
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setNewConvOpen(true)}>
            <Plus className="w-3.5 h-3.5" /> Nova conversa
          </Button>
        </div>
      ) : (
        <div className="flex-1 flex flex-col min-w-0">
          {/* Chat header */}
          <div className="px-4 py-3 border-b border-border flex items-center gap-3 shrink-0 bg-muted/30">
            <div className="w-9 h-9 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center text-green-700 dark:text-green-300 font-semibold text-sm uppercase shrink-0">
              {(selected?.contactName?.[0] ?? selected?.phone[0])}
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-medium text-sm leading-tight">
                {selected?.contactName || formatPhone(selected?.phone ?? "")}
              </p>
              <p className="text-xs text-muted-foreground flex items-center gap-1">
                <Phone className="w-3 h-3" />
                {formatPhone(selected?.phone ?? "")}
              </p>
            </div>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto scrollbar-thin scrollbar-thumb-border scrollbar-track-transparent p-4 space-y-2 bg-[#efeae2] dark:bg-[#0b141a]">
            {msgsLoading ? (
              <div className="flex items-center justify-center h-full text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin mr-2" /> Carregando mensagens...
              </div>
            ) : messages.length === 0 ? (
              <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
                Nenhuma mensagem ainda.
              </div>
            ) : (
              messages.map((msg) => (
                <div
                  key={msg.id}
                  className={cn("flex", msg.direction === "out" ? "justify-end" : "justify-start")}
                >
                  <div
                    className={cn(
                      "max-w-[75%] rounded-2xl px-3 py-2 text-sm shadow-sm",
                      msg.direction === "out"
                        ? "bg-[#d9fdd3] dark:bg-[#005c4b] text-gray-800 dark:text-gray-100 rounded-br-sm"
                        : "bg-white dark:bg-[#202c33] text-gray-800 dark:text-gray-100 rounded-bl-sm"
                    )}
                  >
                    {renderMessageBody(msg.body)}
                    <p className={cn(
                      "text-[10px] mt-1 text-right",
                      msg.direction === "out" ? "text-green-700 dark:text-green-400" : "text-muted-foreground"
                    )}>
                      {formatMsgTime(msg.timestamp)}
                    </p>
                  </div>
                </div>
              ))
            )}
            <div ref={bottomRef} />
          </div>

          {/* Input */}
          <div className="px-3 py-2.5 border-t border-border bg-background shrink-0">
            <div className="flex items-end gap-2">
              {/* Emoji */}
              <Popover open={emojiOpen} onOpenChange={setEmojiOpen}>
                <PopoverTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0 text-muted-foreground hover:text-foreground">
                    <Smile className="w-5 h-5" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent side="top" align="start" className="p-0 w-auto">
                  <EmojiPicker onSelect={(emoji) => { setText((t) => t + emoji); setEmojiOpen(false); setTimeout(() => autoResizeTextarea(), 0); }} />
                </PopoverContent>
              </Popover>

              {/* File attachment */}
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                onChange={handleFileChange}
                accept="*/*"
              />
              <Button
                variant="ghost"
                size="icon"
                className="h-9 w-9 shrink-0 text-muted-foreground hover:text-foreground"
                onClick={() => fileInputRef.current?.click()}
                disabled={fileMutation.isPending}
                title="Anexar documento"
              >
                {fileMutation.isPending ? (
                  <Loader2 className="w-5 h-5 animate-spin" />
                ) : (
                  <Paperclip className="w-5 h-5" />
                )}
              </Button>

              <textarea
                ref={textareaRef}
                value={text}
                onChange={(e) => { setText(e.target.value); autoResizeTextarea(); }}
                onKeyDown={handleKeyDown}
                placeholder="Digite uma mensagem..."
                rows={1}
                className="flex-1 resize-none overflow-y-auto rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 min-h-[36px] max-h-36 scrollbar-thin"
                disabled={replyMutation.isPending}
              />

              <Button
                onClick={handleSend}
                disabled={!text.trim() || replyMutation.isPending}
                size="icon"
                className="h-9 w-9 bg-green-600 hover:bg-green-700 text-white shrink-0"
              >
                {replyMutation.isPending ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Send className="w-4 h-4" />
                )}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* New Conversation Dialog */}
      <Dialog open={newConvOpen} onOpenChange={setNewConvOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Nova Conversa</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                value={contactSearch}
                onChange={(e) => setContactSearch(e.target.value)}
                placeholder="Buscar contato pelo nome ou telefone..."
                className="pl-9"
                autoFocus
              />
            </div>
            <div className="max-h-64 overflow-y-auto scrollbar-thin scrollbar-thumb-border space-y-0.5 border rounded-lg">
              {filteredContacts.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground text-sm">
                  {contactSearch ? "Nenhum contato encontrado." : "Nenhum contato cadastrado."}
                </div>
              ) : (
                filteredContacts.map((c) => (
                  <button
                    key={c.id}
                    className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-muted/60 transition-colors text-left"
                    onClick={() => startConvMutation.mutate({ phone: c.phone, contactName: c.name })}
                    disabled={startConvMutation.isPending}
                  >
                    <div className="w-8 h-8 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center text-green-700 dark:text-green-300 font-semibold text-xs uppercase shrink-0">
                      {c.name[0]}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{c.name}</p>
                      <p className="text-xs text-muted-foreground">{formatPhone(c.phone)}</p>
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => { setNewConvOpen(false); setContactSearch(""); }}>
              Cancelar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
