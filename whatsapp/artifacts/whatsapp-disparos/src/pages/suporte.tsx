import { MessageCircle, Phone, Clock, HelpCircle, BookOpen, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export default function Suporte() {
  const whatsappNumber = "5562992771254";
  const whatsappUrl = `https://wa.me/${whatsappNumber}`;

  const faqs = [
    {
      q: "Como importar minha planilha de contatos?",
      a: "Crie uma nova campanha, avance para o passo de importação e faça upload de um arquivo .xlsx ou .csv. As colunas 'Nome' e 'Telefone' são obrigatórias. CNPJ e outros campos são opcionais.",
    },
    {
      q: "Meus contatos importados ficam salvos no sistema?",
      a: "Sim! Ao importar uma planilha em uma campanha, os contatos são automaticamente salvos na sua base de contatos. Você pode acessá-los pela seção Contatos.",
    },
    {
      q: "O campo CNPJ é obrigatório na planilha?",
      a: "Não. O CNPJ é opcional. Se sua planilha tiver uma coluna chamada 'CNPJ', ela será importada automaticamente para o cadastro de contatos.",
    },
    {
      q: "Como conectar meu WhatsApp ao sistema?",
      a: "Acesse Configurações no menu lateral e clique em 'Conectar WhatsApp'. Escaneie o QR Code com seu celular e o sistema estará pronto para enviar mensagens.",
    },
    {
      q: "Posso usar variáveis nas mensagens?",
      a: "Sim! Use {nome}, {telefone} ou qualquer coluna da sua planilha entre chaves. Por exemplo: {empresa}, {cnpj}. O sistema personaliza automaticamente cada mensagem.",
    },
    {
      q: "Como acompanho o progresso de uma campanha?",
      a: "Na lista de campanhas, você vê o status em tempo real (Pendente, Em andamento, Concluído). Ao clicar em uma campanha, vê detalhes de cada contato e quantas mensagens foram enviadas.",
    },
  ];

  return (
    <div className="max-w-3xl mx-auto space-y-8 animate-in fade-in duration-500">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Suporte</h1>
        <p className="text-muted-foreground mt-1">Estamos aqui para ajudar. Entre em contato ou consulte as perguntas frequentes.</p>
      </div>

      {/* WhatsApp contact card */}
      <Card className="border-green-200 dark:border-green-800 bg-green-50/50 dark:bg-green-900/10">
        <CardContent className="p-6">
          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-6">
            <div className="w-16 h-16 rounded-2xl bg-green-500 flex items-center justify-center shrink-0 shadow-lg shadow-green-500/30">
              <MessageCircle className="w-8 h-8 text-white" />
            </div>
            <div className="flex-1">
              <h2 className="text-xl font-bold mb-1">Fale conosco pelo WhatsApp</h2>
              <p className="text-muted-foreground text-sm mb-3">
                Nossa equipe está disponível para responder suas dúvidas e resolver problemas rapidamente pelo WhatsApp.
              </p>
              <div className="flex items-center gap-2 text-sm text-muted-foreground mb-4">
                <Phone className="w-4 h-4" />
                <span className="font-mono">+55 (62) 99277-1254</span>
              </div>
              <a href={whatsappUrl} target="_blank" rel="noopener noreferrer">
                <Button className="bg-green-600 hover:bg-green-700 text-white gap-2">
                  <MessageCircle className="w-4 h-4" />
                  Abrir WhatsApp
                </Button>
              </a>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Info cards */}
      <div className="grid sm:grid-cols-3 gap-4">
        <Card>
          <CardContent className="p-5 flex flex-col items-center text-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-blue-50 dark:bg-blue-900/30 flex items-center justify-center">
              <Clock className="w-5 h-5 text-blue-600" />
            </div>
            <div>
              <p className="font-semibold text-sm">Horário de atendimento</p>
              <p className="text-xs text-muted-foreground mt-1">Seg–Sex: 8h às 18h<br />Sáb: 8h às 12h</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-5 flex flex-col items-center text-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-green-50 dark:bg-green-900/30 flex items-center justify-center">
              <Zap className="w-5 h-5 text-green-600" />
            </div>
            <div>
              <p className="font-semibold text-sm">Resposta rápida</p>
              <p className="text-xs text-muted-foreground mt-1">Tempo médio de resposta de até 2 horas úteis</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-5 flex flex-col items-center text-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-purple-50 dark:bg-purple-900/30 flex items-center justify-center">
              <BookOpen className="w-5 h-5 text-purple-600" />
            </div>
            <div>
              <p className="font-semibold text-sm">Suporte completo</p>
              <p className="text-xs text-muted-foreground mt-1">Ajudamos com configuração, importação e campanhas</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* FAQ */}
      <div>
        <div className="flex items-center gap-2 mb-5">
          <HelpCircle className="w-5 h-5 text-muted-foreground" />
          <h2 className="text-xl font-semibold">Perguntas frequentes</h2>
        </div>
        <div className="space-y-3">
          {faqs.map((faq, i) => (
            <Card key={i}>
              <CardContent className="p-5">
                <p className="font-medium mb-2 text-sm">{faq.q}</p>
                <p className="text-sm text-muted-foreground leading-relaxed">{faq.a}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}
