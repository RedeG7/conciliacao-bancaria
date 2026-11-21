import { Link, useLocation } from "wouter";
import React, { useState } from "react";
import {
  LayoutDashboard, MessageSquare, FileText, Settings,
  Wifi, WifiOff, LogOut, Users, UserCircle,
  Sun, Moon, Monitor, PanelLeftClose, PanelLeftOpen,
  ContactRound, HeadphonesIcon, MessagesSquare,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useGetWhatsappStatus, getGetWhatsappStatusQueryKey } from "@workspace/api-client-react";
import { useAuth } from "@/hooks/use-auth";
import { useTheme, type Theme } from "@/hooks/use-theme";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { VERSAO } from "@/version";

interface SidebarProps {
  onNavigate?: () => void;
}

const themeOptions: { value: Theme; icon: React.ComponentType<{ className?: string }>; label: string }[] = [
  { value: "light", icon: Sun, label: "Claro" },
  { value: "dark", icon: Moon, label: "Escuro" },
  { value: "system", icon: Monitor, label: "Sistema" },
];

function getSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem("sidebar-collapsed") === "true";
  } catch {
    return false;
  }
}

export function Sidebar({ onNavigate }: SidebarProps) {
  const [location] = useLocation();
  const { username, name, role, logout } = useAuth();
  const { theme, setTheme } = useTheme();
  const [collapsed, setCollapsed] = useState(getSidebarCollapsed);

  const { data: waStatus } = useGetWhatsappStatus({
    query: {
      queryKey: getGetWhatsappStatusQueryKey(),
      refetchInterval: 10000,
    },
  });

  const isConnected = waStatus?.connected ?? false;
  const isSuperAdmin = role === "super_admin";

  const { data: conversations = [] } = useQuery<{ unreadCount: number }[]>({
    queryKey: ["conversations"],
    queryFn: async () => {
      const res = await fetch("/api/conversations", { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    refetchInterval: 15000,
  });
  const totalUnread = Array.isArray(conversations)
    ? conversations.reduce((sum: number, c: any) => sum + (c.unreadCount ?? 0), 0)
    : 0;

  function toggleCollapsed() {
    const next = !collapsed;
    setCollapsed(next);
    try { localStorage.setItem("sidebar-collapsed", String(next)); } catch {}
  }

  const navigation = [
    { name: "Painel", href: "/dashboard", icon: LayoutDashboard },
    { name: "Campanhas", href: "/campanhas", icon: MessageSquare },
    { name: "Conversas", href: "/conversas", icon: MessagesSquare, badge: totalUnread > 0 ? totalUnread : null },
    { name: "Contatos", href: "/contatos", icon: ContactRound },
    { name: "Templates", href: "/templates", icon: FileText },
    isSuperAdmin
      ? { name: "Usuários", href: "/usuarios", icon: Users }
      : { name: "Meu Perfil", href: "/usuarios", icon: UserCircle },
    { name: "Configurações", href: "/configuracoes", icon: Settings },
    { name: "Suporte", href: "/suporte", icon: HeadphonesIcon },
  ];

  return (
    <div
      className={cn(
        "flex flex-col border-r border-sidebar-border bg-sidebar h-screen sticky top-0 transition-[width] duration-300 overflow-hidden shrink-0",
        collapsed ? "w-[60px]" : "w-64"
      )}
    >
      {/* Header with collapse toggle */}
      <div className={cn(
        "flex items-center border-b border-sidebar-border shrink-0 h-[65px]",
        collapsed ? "justify-center px-2" : "gap-3 px-4"
      )}>
        {!collapsed && (
          <>
            <div className="w-8 h-8 bg-primary rounded-md flex items-center justify-center text-primary-foreground font-bold text-sm shrink-0">
              WD
            </div>
            <span className="font-semibold tracking-tight text-sidebar-foreground truncate flex-1 text-sm">
              WA Disparos
            </span>
          </>
        )}
        {/* Toggle button — desktop only */}
        <Tooltip delayDuration={0}>
          <TooltipTrigger asChild>
            <button
              onClick={toggleCollapsed}
              className={cn(
                "hidden md:flex p-1.5 rounded-md text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent transition-colors shrink-0",
                collapsed && "w-full justify-center"
              )}
              aria-label={collapsed ? "Expandir barra lateral" : "Minimizar barra lateral"}
            >
              {collapsed
                ? <PanelLeftOpen className="w-5 h-5" />
                : <PanelLeftClose className="w-5 h-5" />
              }
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">
            {collapsed ? "Expandir barra lateral" : "Minimizar barra lateral"}
          </TooltipContent>
        </Tooltip>
      </div>

      {/* Nav */}
      <nav className={cn(
        "flex-1 py-4 space-y-1 overflow-y-auto overflow-x-hidden",
        collapsed ? "px-2" : "px-3"
      )}>
        {navigation.map((item) => {
          const isActive = location === item.href || location.startsWith(item.href + "/");

          const linkEl = (
            <Link
              key={item.name}
              href={item.href}
              onClick={onNavigate}
              className={cn(
                "flex items-center rounded-md text-sm font-medium transition-colors w-full",
                collapsed ? "justify-center p-2.5" : "gap-3 px-3 py-2.5",
                isActive
                  ? "bg-sidebar-primary text-sidebar-primary-foreground"
                  : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              )}
            >
              <div className="relative shrink-0">
                <item.icon className="w-5 h-5" />
                {collapsed && (item as any).badge ? (
                  <span className="absolute -top-1.5 -right-1.5 w-4 h-4 bg-green-600 text-white text-[9px] font-bold rounded-full flex items-center justify-center leading-none">
                    {(item as any).badge > 9 ? "9+" : (item as any).badge}
                  </span>
                ) : null}
              </div>
              {!collapsed && (
                <>
                  <span className="flex-1 truncate">{item.name}</span>
                  {(item as any).badge ? (
                    <Badge className="h-5 min-w-5 px-1.5 text-[10px] bg-green-600 hover:bg-green-600 shrink-0">
                      {(item as any).badge}
                    </Badge>
                  ) : item.name === "Configurações" ? (
                    isConnected ? (
                      <span className="flex items-center gap-1 text-xs text-green-500 font-normal shrink-0">
                        <Wifi className="w-3.5 h-3.5" /> On
                      </span>
                    ) : (
                      <WifiOff className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                    )
                  ) : null}
                </>
              )}
            </Link>
          );

          if (collapsed) {
            return (
              <Tooltip key={item.name} delayDuration={0}>
                <TooltipTrigger asChild>{linkEl}</TooltipTrigger>
                <TooltipContent side="right" className="flex items-center gap-2">
                  {item.name}
                  {item.name === "Configurações" && (
                    isConnected
                      ? <span className="text-green-500 text-xs ml-1">• Conectado</span>
                      : <span className="text-muted-foreground text-xs ml-1">• Desconectado</span>
                  )}
                </TooltipContent>
              </Tooltip>
            );
          }
          return linkEl;
        })}
      </nav>

      {/* Theme selector */}
      <div className={cn("pb-2 shrink-0", collapsed ? "px-2" : "px-4")}>
        {collapsed ? (
          <div className="flex flex-col items-center gap-0.5">
            {themeOptions.map(({ value, icon: Icon, label }) => (
              <Tooltip key={value} delayDuration={0}>
                <TooltipTrigger asChild>
                  <button
                    onClick={() => setTheme(value)}
                    className={cn(
                      "p-2 rounded w-full flex justify-center transition-colors",
                      theme === value
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:text-foreground hover:bg-muted"
                    )}
                  >
                    <Icon className="w-3.5 h-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right">{label}</TooltipContent>
              </Tooltip>
            ))}
          </div>
        ) : (
          <div className="flex items-center justify-between px-3 py-2 rounded-md bg-muted/50 border border-border">
            <span className="text-xs text-muted-foreground">Tema</span>
            <div className="flex items-center gap-0.5">
              {themeOptions.map(({ value, icon: Icon, label }) => (
                <Tooltip key={value} delayDuration={0}>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => setTheme(value)}
                      className={cn(
                        "p-1.5 rounded transition-colors",
                        theme === value
                          ? "bg-primary text-primary-foreground"
                          : "text-muted-foreground hover:text-foreground hover:bg-muted"
                      )}
                    >
                      <Icon className="w-3.5 h-3.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top">{label}</TooltipContent>
                </Tooltip>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* WhatsApp status pill */}
      {!collapsed && (
        <div className="px-4 pb-2 shrink-0">
          <Link
            href="/configuracoes"
            className={cn(
              "flex items-center gap-2 px-3 py-2 rounded-md text-xs transition-colors cursor-pointer",
              isConnected
                ? "bg-green-50 text-green-700 border border-green-200 dark:bg-green-900/20 dark:text-green-400 dark:border-green-800"
                : "bg-muted/50 text-muted-foreground border border-border"
            )}
          >
            {isConnected ? (
              <><Wifi className="w-3.5 h-3.5 shrink-0" /><span>WhatsApp conectado</span></>
            ) : (
              <><WifiOff className="w-3.5 h-3.5 shrink-0" /><span>WhatsApp desvinculado</span></>
            )}
          </Link>
        </div>
      )}

      {/* User + logout */}
      <div className={cn("border-t border-sidebar-border shrink-0", collapsed ? "p-2" : "p-4")}>
        {collapsed ? (
          <div className="flex flex-col items-center gap-2">
            <Tooltip delayDuration={0}>
              <TooltipTrigger asChild>
                <div className="w-8 h-8 rounded-full bg-sidebar-accent border border-sidebar-border flex items-center justify-center text-xs font-medium text-sidebar-foreground uppercase cursor-default">
                  {(name || username || "U")[0]}
                </div>
              </TooltipTrigger>
              <TooltipContent side="right">
                <p>{name || username || "Usuário"}</p>
                {isSuperAdmin && <p className="text-xs text-muted-foreground">Super Admin</p>}
              </TooltipContent>
            </Tooltip>
            <Tooltip delayDuration={0}>
              <TooltipTrigger asChild>
                <button
                  onClick={logout}
                  className="text-sidebar-foreground/60 hover:text-sidebar-foreground transition-colors p-1.5 rounded hover:bg-sidebar-accent"
                >
                  <LogOut className="w-4 h-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">Sair</TooltipContent>
            </Tooltip>
          </div>
        ) : (
          <div className="flex items-center gap-3 px-3 py-2">
            <div className="w-8 h-8 rounded-full bg-sidebar-accent border border-sidebar-border flex items-center justify-center text-xs font-medium text-sidebar-foreground uppercase shrink-0">
              {(name || username || "U")[0]}
            </div>
            <div className="flex flex-col flex-1 min-w-0">
              <span className="text-sm font-medium text-sidebar-foreground leading-none truncate">
                {name || username || "Usuário"}
              </span>
              {isSuperAdmin && (
                <span className="text-xs text-muted-foreground mt-0.5">Super Admin</span>
              )}
            </div>
            <button
              onClick={logout}
              title="Sair"
              className="text-sidebar-foreground/60 hover:text-sidebar-foreground transition-colors p-1 rounded"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        )}
        <p className="text-[10px] text-muted-foreground text-center mt-1">v{VERSAO}</p>
      </div>
    </div>
  );
}
