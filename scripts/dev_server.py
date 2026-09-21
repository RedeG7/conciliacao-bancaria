#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Sobe o app_conciliacao.py via Streamlit na porta indicada por $PORT
(env var setada pelo Claude Code quando varias sessoes rodam o preview ao
mesmo tempo no mesmo projeto - sem isso, todas brigariam pela 8501 fixa).
Fora do Claude Code, sem $PORT definida, cai na 8501 de sempre."""
from __future__ import annotations

import os
import sys
from pathlib import Path

porta = os.environ.get("PORT", "8501")
app_path = str(Path(__file__).resolve().parent.parent / "app_conciliacao.py")

import streamlit.web.cli as stcli

sys.argv = [
    "streamlit", "run", app_path,
    "--server.headless", "true",
    "--server.port", porta,
]
sys.exit(stcli.main())
