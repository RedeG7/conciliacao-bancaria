"""Processamento de uma linha da fila do RPA NF GO (empresa + tipo de nota)
— chamado pelo worker via rpa.registry.processar_empresa.

A planilha gera duas linhas por empresa, ENTRADA e depois SAIDA (ver
planilha.py): o worker processa em ordem de id, então a Saída de uma
empresa roda logo depois da Entrada dela, na mesma sessão - igual ao
roteiro manual ("Nova consulta" com a mesma Inscrição Estadual).

Para cada linha:
  1. formulário Baixar XML NF-e: período da competência, IE, tipo, modelo Todas
  2. Pesquisar -> lê o total de notas da tela + print (evidência)
  3. sem resultado -> "Sem movimento" (só o print, sem ZIP)
  4. com resultado -> Baixar todos > documentos e eventos > Baixar, renomeia
     para ENTRADA_MMAAAA.zip / SAIDA_MMAAAA.zip, confere quantos XMLs de nota
     vieram contra o total da tela
  5. Nova consulta (prepara a próxima linha)
"""

from playwright.sync_api import Page

from rpa.sefazgo_nfe import arquivos, portal

MOVIMENTO_COM = "Com movimento"
MOVIMENTO_SEM = "Sem movimento"


def processar_empresa(page: Page, empresa: dict, competencia: dict) -> dict:
    """empresa: linha de rpa_empresas (codigo, razao_social,
    inscricao_estadual, obrigacao=ENTRADA|SAIDA). Retorna o dict que o
    worker grava na linha (status, movimento, xml_zip, evidencia_png,
    qtd_notas_portal, qtd_xml, observacao, arquivos p/ gravar em disco)
    ou levanta portal.ErroPortal."""
    tipo = (empresa.get("obrigacao") or "").upper()
    if tipo not in portal.TEXTOS_TIPO:
        raise portal.ErroPortal(f"[fila] tipo de nota inválido na linha: '{tipo}' (esperado ENTRADA ou SAIDA)")
    ie = empresa.get("inscricao_estadual") or ""
    if not ie:
        raise portal.ErroPortal("[fila] empresa sem Inscrição Estadual na planilha")

    mm_aaaa = competencia["mm_aaaa"]
    pasta = arquivos.pasta_relativa(empresa["codigo"], empresa.get("razao_social") or "", mm_aaaa, tipo)
    nome_print = arquivos.nome_evidencia(tipo, mm_aaaa)

    portal.abrir_formulario(page)
    portal.pesquisar(page, competencia["data_inicial"], competencia["data_final"], ie, tipo)

    texto = portal.texto_da_tela(page)
    print_png = portal.evidencia(page)
    qtd_portal = arquivos.extrair_quantidade(texto)

    if arquivos.sem_resultado(texto) and not qtd_portal:
        portal.nova_consulta(page)
        return {
            "status": "CONCLUIDO",
            "movimento": MOVIMENTO_SEM,
            "qtd_notas_portal": 0,
            "qtd_xml": 0,
            "evidencia_png": print_png,
            "observacao": "",
            "arquivos": {f"{pasta}/{nome_print}": print_png},
        }

    bruto, nome_original = portal.baixar_todos(page)
    try:
        zip_bytes = arquivos.padronizar_download(bruto, nome_original)
        contagem = arquivos.contar_xmls(zip_bytes)
    except arquivos.ArquivoInvalido as exc:
        raise portal.ErroPortal(f"[download] {exc}") from exc

    situacao, observacao = arquivos.conferir(qtd_portal, contagem)
    if contagem["eventos"]:
        observacao = (observacao + " " if observacao else "") + f"(+ {contagem['eventos']} XML(s) de evento)"

    portal.nova_consulta(page)

    nome_zip = arquivos.nome_zip(tipo, mm_aaaa)
    return {
        # INCOMPLETO vira ERRO (reprocessável pela tela), mas os arquivos
        # baixados ficam gravados pra conferência
        "status": "ERRO" if situacao == "INCOMPLETO" else "CONCLUIDO",
        "movimento": MOVIMENTO_COM,
        "xml_zip": zip_bytes,
        "xml_zip_nome": nome_zip,
        "qtd_notas_portal": qtd_portal,
        "qtd_xml": contagem["notas"],
        "evidencia_png": print_png,
        "observacao": observacao,
        "erro": observacao if situacao == "INCOMPLETO" else "",
        "arquivos": {f"{pasta}/{nome_zip}": zip_bytes, f"{pasta}/{nome_print}": print_png},
    }
