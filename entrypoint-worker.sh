#!/bin/sh
# Sobe Xvfb em background e so entao troca (exec) pro worker Python, ja com
# DISPLAY configurado - troquei o xvfb-run (Debian) por isso porque ele
# depende de receber SIGUSR1 do Xvfb pra saber que o display esta pronto, e
# esse sinal nunca chegou rodando como PID 1 do container (worker ficava
# parado pra sempre, sem nenhum log, Xvfb rodando mas o Python nunca
# iniciava). Aqui a espera e por polling do arquivo de lock, sem depender de
# sinal nenhum.
set -e

Xvfb :99 -screen 0 1280x1024x24 -ac -nolisten tcp &

for i in $(seq 1 30); do
    if [ -e /tmp/.X99-lock ]; then
        break
    fi
    sleep 0.5
done

export DISPLAY=:99
exec python rpa_worker.py
