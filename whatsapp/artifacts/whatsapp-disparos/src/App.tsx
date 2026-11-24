import { Switch, Route, Router as WouterRouter, Redirect } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";

import { Layout } from "@/components/layout/layout";
import Dashboard from "@/pages/dashboard";
import CampaignsList from "@/pages/campaigns/list";
import NewCampaign from "@/pages/campaigns/new";
import CampaignDetail from "@/pages/campaigns/detail";
import TemplatesList from "@/pages/templates/list";
import Configuracoes from "@/pages/configuracoes";
import UsuariosList from "@/pages/usuarios";
import ContatosList from "@/pages/contatos/list";
import Suporte from "@/pages/suporte";
import ConversasPage from "@/pages/conversas";
import Home from "@/pages/home";
import Login from "@/pages/login";
import { AuthContext, useAuthProvider } from "@/hooks/use-auth";
import { ThemeContext, useThemeProvider } from "@/hooks/use-theme";
import { Loader2 } from "lucide-react";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error: any) => {
        if (error?.status === 401) return false;
        return failureCount < 2;
      },
    },
  },
});

function AuthenticatedRouter() {
  return (
    <Switch>
      <Route path="/" component={Home} />
      <Route>
        <Layout>
          <Switch>
            <Route path="/dashboard" component={Dashboard} />
            <Route path="/campanhas/nova" component={NewCampaign} />
            <Route path="/campanhas/:id" component={CampaignDetail} />
            <Route path="/campanhas" component={CampaignsList} />
            <Route path="/templates" component={TemplatesList} />
            <Route path="/configuracoes" component={Configuracoes} />
            <Route path="/usuarios" component={UsuariosList} />
            <Route path="/contatos" component={ContatosList} />
            <Route path="/conversas" component={ConversasPage} />
            <Route path="/suporte" component={Suporte} />
            <Route component={NotFound} />
          </Switch>
        </Layout>
      </Route>
    </Switch>
  );
}

function PublicRouter({ onLogin }: { onLogin: (data: any) => void }) {
  return (
    <Switch>
      <Route path="/home" component={Home} />
      <Route path="/login">
        {() => <Login onLogin={onLogin} />}
      </Route>
      <Route>
        <Home />
      </Route>
    </Switch>
  );
}

function AuthGatedApp() {
  const auth = useAuthProvider();

  if (auth.loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-green-600" />
      </div>
    );
  }

  if (!auth.authenticated) {
    return (
      <AuthContext.Provider value={auth}>
        <PublicRouter onLogin={(data) => auth.markLoggedIn(data)} />
      </AuthContext.Provider>
    );
  }

  return (
    <AuthContext.Provider value={auth}>
      <AuthenticatedRouter />
    </AuthContext.Provider>
  );
}

function App() {
  const themeProviderValue = useThemeProvider();
  return (
    <ThemeContext.Provider value={themeProviderValue}>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
            <AuthGatedApp />
          </WouterRouter>
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeContext.Provider>
  );
}

export default App;
