# Audio Auto Recorder MP3

## 1. Instalação da extensão
1. Extraia esta pasta.
2. Abra `chrome://extensions`.
3. Ative Modo do desenvolvedor.
4. Carregar sem compactação.
5. Selecione `audio-auto-recorder-v4`.

## 2. Conversor MP3 no Linux
Uma única vez:

```bash
sudo apt install ffmpeg
cd audio-auto-recorder-v4
./converter/install_autostart.sh
```

Depois disso não é necessário deixar terminal aberto. O conversor roda como serviço do usuário e transforma os WebM temporários em MP3.

## 3. Uso
1. Abra a página e deixe o áudio tocar.
2. Clique na extensão.
3. Clique `Iniciar gravação contínua`.
4. Pode sair da frente do computador.
5. Cada mudança do texto do `span.e-10860-text.encore-text-title-small[data-encore-id="text"]` encerra o segmento anterior e inicia o próximo.
6. Ao clicar `Parar e salvar último segmento`, a extensão aguarda a finalização do MediaRecorder e só então confirma a parada.

## Pasta
`~/Downloads/Audio Auto Recorder/`

Temporários:
`~/Downloads/Audio Auto Recorder/.recording_tmp/`

## Importante
O computador não pode suspender e o Chrome precisa permanecer aberto. A guia precisa continuar reproduzindo o áudio.
