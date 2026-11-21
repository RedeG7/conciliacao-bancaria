import { Link } from "wouter";
import {
  MessageSquare, FileSpreadsheet, Zap, BarChart3, Upload, Clock,
  CheckCircle, Users, Building2, TrendingUp, Briefcase, ChevronRight,
  MessageCircle, LayoutDashboard,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";

export default function Home() {
  const { authenticated } = useAuth();

  const handleWhatsApp = () => {
    window.open("https://wa.me/5562992771254", "_blank");
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Navbar */}
      <header className="sticky top-0 z-50 border-b border-border bg-background/80 backdrop-blur-sm">
        <div className="max-w-6xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-green-600 rounded-lg flex items-center justify-center">
              <MessageSquare className="w-4 h-4 text-white" />
            </div>
            <span className="font-bold text-lg">AutoEnvioPro</span>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={handleWhatsApp}
              className="hidden sm:flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              <MessageCircle className="w-4 h-4 text-green-500" />
              Suporte
            </button>
            {authenticated ? (
              <Link href="/campanhas">
                <Button size="sm" className="bg-green-600 hover:bg-green-700 text-white gap-1.5">
                  <LayoutDashboard className="w-4 h-4" />
                  Acessar Painel
                </Button>
              </Link>
            ) : (
              <>
                <Link href="/login">
                  <Button variant="outline" size="sm">Entrar</Button>
                </Link>
                <Link href="/login">
                  <Button size="sm" className="bg-green-600 hover:bg-green-700 text-white">
                    Começar agora
                  </Button>
                </Link>
              </>
            )}
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="relative overflow-hidden py-20 px-4 text-center">
        <div className="absolute inset-0 -z-10 bg-gradient-to-b from-green-50/60 to-transparent dark:from-green-950/20" />
        <div className="max-w-4xl mx-auto space-y-6">
          <div className="inline-flex items-center gap-2 bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-300 border border-green-200 dark:border-green-800 rounded-full px-4 py-1.5 text-sm font-medium">
            <Zap className="w-3.5 h-3.5" />
            Automação de WhatsApp para empresas
          </div>
          <h1 className="text-4xl sm:text-5xl md:text-6xl font-extrabold tracking-tight leading-tight">
            Automatize o envio de mensagens no{" "}
            <span className="text-green-600">WhatsApp</span> com campanhas inteligentes
          </h1>
          <p className="text-lg text-muted-foreground max-w-2xl mx-auto leading-relaxed">
            Envie mensagens personalizadas para centenas de contatos em poucos minutos. Basta importar sua planilha com nome e telefone, criar uma campanha e deixar o sistema fazer os envios automaticamente.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3 pt-2">
            <Link href={authenticated ? "/campanhas" : "/login"}>
              <Button size="lg" className="bg-green-600 hover:bg-green-700 text-white gap-2 text-base px-8">
                {authenticated ? "Acessar minhas campanhas" : "Criar minha campanha"} <ChevronRight className="w-4 h-4" />
              </Button>
            </Link>
            <a href="#como-funciona">
              <Button size="lg" variant="outline" className="gap-2 text-base px-8">
                Ver como funciona
              </Button>
            </a>
          </div>
        </div>

        {/* Hero illustration */}
        <div className="mt-16 max-w-3xl mx-auto">
          <div className="rounded-2xl border border-border bg-card shadow-2xl overflow-hidden">
            <div className="bg-muted/50 px-4 py-3 flex items-center gap-2 border-b border-border">
              <div className="w-3 h-3 rounded-full bg-red-400" />
              <div className="w-3 h-3 rounded-full bg-yellow-400" />
              <div className="w-3 h-3 rounded-full bg-green-400" />
              <span className="ml-2 text-xs text-muted-foreground">AutoEnvioPro — Campanhas</span>
            </div>
            <div className="p-6 space-y-3">
              {[
                { name: "Campanha Clientes Ativos", contacts: 248, sent: 248, status: "Concluído" },
                { name: "Prospecção B2B Novembro", contacts: 132, sent: 89, status: "Em andamento" },
                { name: "Reativação Leads Frios", contacts: 315, sent: 0, status: "Pendente" },
              ].map((camp) => (
                <div key={camp.name} className="flex items-center justify-between p-3 rounded-lg bg-muted/40 border border-border">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-md bg-green-100 dark:bg-green-900/40 flex items-center justify-center">
                      <MessageSquare className="w-4 h-4 text-green-600" />
                    </div>
                    <div>
                      <p className="text-sm font-medium">{camp.name}</p>
                      <p className="text-xs text-muted-foreground">{camp.contacts} contatos</p>
                    </div>
                  </div>
                  <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${
                    camp.status === "Concluído"
                      ? "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300"
                      : camp.status === "Em andamento"
                      ? "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300"
                      : "bg-muted text-muted-foreground"
                  }`}>
                    {camp.status}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* How it works */}
      <section id="como-funciona" className="py-20 px-4">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-14">
            <h2 className="text-3xl font-bold mb-3">Como funciona o sistema</h2>
            <p className="text-muted-foreground text-lg">Simples, rápido e eficiente</p>
            <p className="text-muted-foreground max-w-xl mx-auto mt-2">
              Com o AutoEnvioPro, você consegue enviar mensagens para vários contatos de forma organizada e personalizada em apenas alguns passos.
            </p>
          </div>
          <div className="grid md:grid-cols-3 gap-8">
            {[
              {
                step: "1",
                icon: MessageSquare,
                title: "Crie uma campanha",
                desc: "Defina o nome da campanha e escolha o modelo de mensagem que será enviado.",
                color: "bg-green-50 dark:bg-green-900/30 text-green-600",
              },
              {
                step: "2",
                icon: FileSpreadsheet,
                title: "Importe sua planilha",
                desc: "Envie um arquivo Excel ou CSV contendo Nome, Telefone e CNPJ da empresa (opcional).",
                color: "bg-blue-50 dark:bg-blue-900/30 text-blue-600",
              },
              {
                step: "3",
                icon: Zap,
                title: "Envio automático",
                desc: "O sistema personaliza cada mensagem e realiza o envio automaticamente pelo WhatsApp.",
                color: "bg-purple-50 dark:bg-purple-900/30 text-purple-600",
              },
            ].map((item) => (
              <div key={item.step} className="relative flex flex-col items-center text-center p-6 rounded-2xl border border-border bg-card">
                <div className={`w-14 h-14 rounded-xl ${item.color} flex items-center justify-center mb-4`}>
                  <item.icon className="w-7 h-7" />
                </div>
                <div className="absolute -top-3 -right-3 w-7 h-7 bg-primary text-primary-foreground rounded-full text-sm font-bold flex items-center justify-center shadow">
                  {item.step}
                </div>
                <h3 className="font-semibold text-lg mb-2">{item.title}</h3>
                <p className="text-muted-foreground text-sm leading-relaxed">{item.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Message personalization */}
      <section className="py-20 px-4 bg-muted/30">
        <div className="max-w-5xl mx-auto">
          <div className="grid md:grid-cols-2 gap-12 items-center">
            <div>
              <h2 className="text-3xl font-bold mb-4">Mensagens inteligentes e personalizadas</h2>
              <p className="text-muted-foreground mb-6 leading-relaxed">
                Com os Templates de Mensagem, você pode criar textos que se adaptam automaticamente aos dados de cada contato. Assim cada cliente recebe uma mensagem única, aumentando a chance de resposta.
              </p>
              <div className="space-y-3">
                {[
                  "Use {nome} para personalizar com o nome do contato",
                  "Use {empresa} para mencionar a empresa",
                  "Use qualquer coluna da planilha como variável",
                ].map((tip) => (
                  <div key={tip} className="flex items-start gap-2">
                    <CheckCircle className="w-5 h-5 text-green-500 mt-0.5 shrink-0" />
                    <p className="text-sm text-muted-foreground">{tip}</p>
                  </div>
                ))}
              </div>
            </div>
            <div className="rounded-2xl border border-border bg-card p-6 space-y-3 shadow-lg">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Exemplo de template</p>
              <div className="bg-muted/50 rounded-xl p-4 text-sm leading-relaxed border border-border">
                <p>Olá <span className="bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300 px-1.5 py-0.5 rounded font-mono text-xs">{"{"} nome {"}"}</span>, tudo bem?</p>
                <br />
                <p>Estamos entrando em contato referente à empresa <span className="bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 px-1.5 py-0.5 rounded font-mono text-xs">{"{"} empresa {"}"}</span>.</p>
                <br />
                <p>Gostaríamos de apresentar nossos serviços.</p>
              </div>
              <div className="border-t border-border pt-3">
                <p className="text-xs text-muted-foreground mb-2">Resultado para João da Silva (Contabilidade ABC):</p>
                <div className="bg-green-50 dark:bg-green-900/20 rounded-xl p-4 text-sm leading-relaxed border border-green-200 dark:border-green-800">
                  <p>Olá <strong>João da Silva</strong>, tudo bem?</p>
                  <br />
                  <p>Estamos entrando em contato referente à empresa <strong>Contabilidade ABC</strong>.</p>
                  <br />
                  <p>Gostaríamos de apresentar nossos serviços.</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="py-20 px-4">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-14">
            <h2 className="text-3xl font-bold mb-3">Funcionalidades do sistema</h2>
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {[
              { icon: BarChart3, title: "Gestão de campanhas", desc: "Crie e acompanhe suas campanhas de envio de mensagens em tempo real.", color: "text-green-600 bg-green-50 dark:bg-green-900/30" },
              { icon: Upload, title: "Importação de contatos", desc: "Importe listas facilmente através de planilhas Excel ou CSV com suporte a CNPJ.", color: "text-blue-600 bg-blue-50 dark:bg-blue-900/30" },
              { icon: MessageSquare, title: "Templates de mensagens", desc: "Crie mensagens reutilizáveis com variáveis personalizadas para cada contato.", color: "text-purple-600 bg-purple-50 dark:bg-purple-900/30" },
              { icon: Clock, title: "Histórico de envios", desc: "Acompanhe todas as campanhas realizadas e mensagens enviadas com detalhes.", color: "text-orange-600 bg-orange-50 dark:bg-orange-900/30" },
              { icon: Zap, title: "Automação de envios", desc: "Economize tempo enviando mensagens para diversos contatos automaticamente.", color: "text-yellow-600 bg-yellow-50 dark:bg-yellow-900/30" },
              { icon: Users, title: "Gestão de contatos", desc: "Banco de dados de contatos com CNPJ, empresa e campos personalizados.", color: "text-teal-600 bg-teal-50 dark:bg-teal-900/30" },
            ].map((feat) => (
              <div key={feat.title} className="p-6 rounded-2xl border border-border bg-card hover:shadow-md transition-shadow">
                <div className={`w-11 h-11 rounded-lg ${feat.color} flex items-center justify-center mb-4`}>
                  <feat.icon className="w-5 h-5" />
                </div>
                <h3 className="font-semibold mb-2">{feat.title}</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">{feat.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Who is it for */}
      <section className="py-20 px-4 bg-muted/30">
        <div className="max-w-5xl mx-auto">
          <div className="grid md:grid-cols-2 gap-12 items-center">
            <div>
              <h2 className="text-3xl font-bold mb-4">Para quem é esse sistema</h2>
              <p className="text-muted-foreground mb-6">O AutoEnvioPro é ideal para empresas e profissionais que precisam se comunicar em escala com seus clientes ou leads.</p>
              <div className="grid grid-cols-2 gap-3">
                {[
                  { icon: Building2, label: "Escritórios contábeis" },
                  { icon: TrendingUp, label: "Empresas de marketing" },
                  { icon: Briefcase, label: "Times comerciais" },
                  { icon: Users, label: "Vendas B2B" },
                  { icon: MessageSquare, label: "Geração de leads" },
                  { icon: Zap, label: "Qualquer negócio" },
                ].map((item) => (
                  <div key={item.label} className="flex items-center gap-2 p-3 rounded-xl bg-card border border-border">
                    <item.icon className="w-4 h-4 text-green-600 shrink-0" />
                    <span className="text-sm font-medium">{item.label}</span>
                  </div>
                ))}
              </div>
            </div>
            {/* Benefits */}
            <div className="space-y-4">
              <h2 className="text-2xl font-bold mb-6">Benefícios</h2>
              {[
                "Economize horas de trabalho manual",
                "Organize seus contatos em campanhas",
                "Envie mensagens personalizadas em escala",
                "Tenha histórico completo de todos os envios",
                "Simplifique sua prospecção de clientes",
              ].map((benefit) => (
                <div key={benefit} className="flex items-center gap-3 p-4 rounded-xl bg-card border border-border">
                  <div className="w-8 h-8 rounded-full bg-green-100 dark:bg-green-900/40 flex items-center justify-center shrink-0">
                    <CheckCircle className="w-4 h-4 text-green-600" />
                  </div>
                  <span className="font-medium">{benefit}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* CTA final */}
      <section className="py-24 px-4">
        <div className="max-w-3xl mx-auto text-center space-y-6">
          <h2 className="text-4xl font-extrabold tracking-tight">
            Comece a automatizar seus envios agora
          </h2>
          <p className="text-muted-foreground text-lg">
            Crie campanhas de WhatsApp em poucos minutos e fale com seus leads de forma mais rápida e organizada.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
            <Link href="/login">
              <Button size="lg" className="bg-green-600 hover:bg-green-700 text-white gap-2 text-base px-8">
                Criar minha primeira campanha <ChevronRight className="w-4 h-4" />
              </Button>
            </Link>
            <Button size="lg" variant="outline" className="gap-2 text-base px-8" onClick={handleWhatsApp}>
              <MessageCircle className="w-5 h-5 text-green-500" />
              Falar com suporte
            </Button>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-border py-8 px-4">
        <div className="max-w-5xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 bg-green-600 rounded-lg flex items-center justify-center">
              <MessageSquare className="w-3.5 h-3.5 text-white" />
            </div>
            <span className="font-bold">AutoEnvioPro</span>
          </div>
          <p className="text-sm text-muted-foreground">© 2025 AutoEnvioPro. Todos os direitos reservados.</p>
          <button onClick={handleWhatsApp} className="flex items-center gap-1.5 text-sm text-green-600 hover:text-green-700 transition-colors">
            <MessageCircle className="w-4 h-4" />
            Suporte via WhatsApp
          </button>
        </div>
      </footer>
    </div>
  );
}
