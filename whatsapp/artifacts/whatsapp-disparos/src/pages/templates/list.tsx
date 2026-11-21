import { useState, useRef } from "react";
import { useListTemplates, useCreateTemplate, useUpdateTemplate, useDeleteTemplate } from "@workspace/api-client-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Plus, Edit2, Trash2, Save, X, MessageSquareQuote, ImagePlus, Image } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";

async function uploadImage(file: File): Promise<string> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch("/api/upload", {
    method: "POST",
    body: form,
    credentials: "include",
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Erro ao fazer upload" }));
    throw new Error(err.error ?? "Erro ao fazer upload");
  }
  const data = await res.json();
  return data.url as string;
}

export default function TemplatesList() {
  const { data: templates, isLoading, refetch } = useListTemplates();
  const createTemplate = useCreateTemplate();
  const updateTemplate = useUpdateTemplate();
  const deleteTemplate = useDeleteTemplate();
  const { toast } = useToast();

  const [isEditing, setIsEditing] = useState(false);
  const [currentId, setCurrentId] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const resetForm = () => {
    setIsEditing(false);
    setCurrentId(null);
    setName("");
    setBody("");
    setImageUrl(null);
    setImagePreview(null);
    setImageFile(null);
  };

  const handleEdit = (t: any) => {
    setCurrentId(t.id);
    setName(t.name);
    setBody(t.body);
    setImageUrl(t.imageUrl ?? null);
    setImagePreview(t.imageUrl ?? null);
    setImageFile(null);
    setIsEditing(true);
  };

  const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImageFile(file);
    const reader = new FileReader();
    reader.onload = (ev) => setImagePreview(ev.target?.result as string);
    reader.readAsDataURL(file);
  };

  const handleRemoveImage = () => {
    setImageFile(null);
    setImagePreview(null);
    setImageUrl(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleSave = async () => {
    if (!name || !body) {
      toast({ title: "Preencha todos os campos", variant: "destructive" });
      return;
    }

    let finalImageUrl = imageUrl;

    if (imageFile) {
      setUploading(true);
      try {
        finalImageUrl = await uploadImage(imageFile);
        setImageUrl(finalImageUrl);
      } catch (err: any) {
        toast({ title: err.message ?? "Erro ao fazer upload da imagem", variant: "destructive" });
        setUploading(false);
        return;
      } finally {
        setUploading(false);
      }
    }

    const data = { name, body, imageUrl: finalImageUrl ?? undefined };

    if (currentId) {
      updateTemplate.mutate({ id: currentId, data }, {
        onSuccess: () => {
          toast({ title: "Template atualizado" });
          refetch();
          resetForm();
        }
      });
    } else {
      createTemplate.mutate({ data }, {
        onSuccess: () => {
          toast({ title: "Template criado" });
          refetch();
          resetForm();
        }
      });
    }
  };

  const handleDelete = (id: number) => {
    if (confirm("Tem certeza que deseja excluir este template?")) {
      deleteTemplate.mutate({ id }, {
        onSuccess: () => {
          toast({ title: "Template excluído" });
          refetch();
        }
      });
    }
  };

  const insertVariable = (variable: string) => {
    setBody(prev => prev + variable);
  };

  const isSaving = uploading || createTemplate.isPending || updateTemplate.isPending;

  return (
    <div className="space-y-6 animate-in fade-in duration-500 max-w-5xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Templates</h1>
          <p className="text-muted-foreground mt-1">Crie mensagens padronizadas com variáveis dinâmicas.</p>
        </div>
        {!isEditing && (
          <Button onClick={() => setIsEditing(true)} className="gap-2">
            <Plus className="w-4 h-4" /> Novo Template
          </Button>
        )}
      </div>

      {isEditing && (
        <Card className="border-primary/50 shadow-md">
          <CardHeader>
            <CardTitle>{currentId ? 'Editar Template' : 'Novo Template'}</CardTitle>
            <CardDescription>Use chaves para variáveis. Ex: {"{nome}"}, {"{valor}"}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>Nome do Template</Label>
              <Input value={name} onChange={e => setName(e.target.value)} placeholder="Ex: Cobrança Mensal" />
            </div>

            <div className="space-y-2">
              <Label>Imagem (opcional)</Label>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/gif,image/webp"
                className="hidden"
                onChange={handleImageChange}
              />
              {imagePreview ? (
                <div className="relative inline-block">
                  <img
                    src={imagePreview}
                    alt="Preview"
                    className="w-full max-w-xs h-40 object-cover rounded-lg border"
                  />
                  <Button
                    type="button"
                    variant="destructive"
                    size="icon"
                    className="absolute top-1 right-1 h-6 w-6"
                    onClick={handleRemoveImage}
                  >
                    <X className="h-3 w-3" />
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="mt-2 gap-1 text-xs w-full max-w-xs"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <ImagePlus className="h-3 w-3" /> Trocar imagem
                  </Button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="flex flex-col items-center justify-center w-full max-w-xs h-32 border-2 border-dashed border-muted-foreground/30 rounded-lg hover:border-primary/50 hover:bg-muted/30 transition-colors cursor-pointer gap-2"
                >
                  <ImagePlus className="h-8 w-8 text-muted-foreground/50" />
                  <span className="text-sm text-muted-foreground">Clique para adicionar imagem</span>
                  <span className="text-xs text-muted-foreground/60">JPG, PNG, GIF ou WebP • máx. 10MB</span>
                </button>
              )}
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Mensagem</Label>
                <div className="flex gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={() => insertVariable('{nome}')} className="h-7 text-xs">
                    + Nome
                  </Button>
                  <Button type="button" variant="outline" size="sm" onClick={() => insertVariable('{telefone}')} className="h-7 text-xs">
                    + Telefone
                  </Button>
                </div>
              </div>
              <Textarea
                value={body}
                onChange={e => setBody(e.target.value)}
                placeholder="Olá {nome}, tudo bem?..."
                className="min-h-[150px] font-mono text-sm resize-y"
              />
              {imagePreview && (
                <p className="text-xs text-muted-foreground">A mensagem será enviada como legenda da imagem.</p>
              )}
            </div>
          </CardContent>
          <CardFooter className="justify-end gap-2">
            <Button variant="ghost" onClick={resetForm} disabled={isSaving}>Cancelar</Button>
            <Button onClick={handleSave} className="gap-2" disabled={isSaving}>
              <Save className="w-4 h-4" />
              {uploading ? "Enviando imagem..." : isSaving ? "Salvando..." : "Salvar Template"}
            </Button>
          </CardFooter>
        </Card>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        {isLoading ? (
          <div className="col-span-2 text-center py-12 text-muted-foreground">Carregando templates...</div>
        ) : templates?.length === 0 && !isEditing ? (
          <div className="col-span-2 text-center py-16 border rounded-xl border-dashed bg-muted/10">
            <MessageSquareQuote className="mx-auto h-12 w-12 text-muted-foreground/30 mb-4" />
            <h3 className="text-lg font-medium mb-2">Nenhum template criado</h3>
            <Button onClick={() => setIsEditing(true)} variant="outline">Criar meu primeiro template</Button>
          </div>
        ) : (
          templates?.map(template => (
            <Card key={template.id} className="flex flex-col hover-elevate transition-all">
              <CardHeader className="pb-3 flex flex-row items-start justify-between space-y-0">
                <div>
                  <CardTitle className="text-lg flex items-center gap-2">
                    {template.name}
                    {template.imageUrl && <Image className="h-4 w-4 text-muted-foreground" />}
                  </CardTitle>
                  <CardDescription className="text-xs mt-1">
                    {format(new Date(template.createdAt), "dd MMM yyyy", { locale: ptBR })}
                  </CardDescription>
                </div>
                <div className="flex gap-1">
                  <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => handleEdit(template)}>
                    <Edit2 className="h-4 w-4" />
                  </Button>
                  <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:bg-destructive/10" onClick={() => handleDelete(template.id)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </CardHeader>
              {template.imageUrl && (
                <div className="px-6 pb-3">
                  <img
                    src={template.imageUrl}
                    alt="Imagem do template"
                    className="w-full h-32 object-cover rounded-md"
                  />
                </div>
              )}
              <CardContent className="flex-1">
                <div className="bg-muted/50 p-4 rounded-md text-sm font-mono whitespace-pre-wrap text-muted-foreground h-full line-clamp-4 overflow-hidden">
                  {template.body}
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}
