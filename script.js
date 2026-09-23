/* =========================================================================
   Conversor de Vídeo para MP3
   - Conversão real de áudio via FFmpeg WebAssembly (processamento 100% local)
   - Nenhum vídeo/áudio é enviado para servidores; apenas o motor FFmpeg
     (código, não dados do usuário) é baixado de uma CDN pública na 1ª conversão.
   ========================================================================= */

/* ---------- Bibliotecas externas utilizadas -----------------------------
   @ffmpeg/ffmpeg (0.12.x) e @ffmpeg/util (0.12.x), carregadas via import()
   dinâmico a partir da CDN jsdelivr, no momento em que o usuário inicia a
   primeira conversão (não são baixadas antes disso).
   -------------------------------------------------------------------- */
const FFMPEG_JS_URL = "https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/esm/index.js";
const FFMPEG_UTIL_URL = "https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.2/dist/esm/index.js";
const FFMPEG_CORE_BASE = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm";

const ALLOWED_EXTENSIONS = [
  "mp4", "avi", "mkv", "mov", "webm", "wmv", "flv", "mpeg", "mpg", "m4v", "3gp"
];

const LARGE_FILE_WARNING_BYTES = 1024 * 1024 * 1024; // 1 GB

/* ---------- Referências de elementos ------------------------------------ */
const el = {
  incompatibleBanner: document.getElementById("incompatible-banner"),
  incompatibleMessage: document.getElementById("incompatible-message"),

  btnChooseVideo: document.getElementById("btn-choose-video"),
  videoInput: document.getElementById("video-input"),
  fileInfo: document.getElementById("file-info"),
  fileName: document.getElementById("file-name"),
  fileExt: document.getElementById("file-ext"),
  fileSize: document.getElementById("file-size"),
  fileDuration: document.getElementById("file-duration"),
  fileError: document.getElementById("file-error"),

  outputFilename: document.getElementById("output-filename"),

  saveFsapiBlock: document.getElementById("save-fsapi-block"),
  saveFallbackBlock: document.getElementById("save-fallback-block"),
  btnChooseFolder: document.getElementById("btn-choose-folder"),
  saveLocationStatus: document.getElementById("save-location-status"),

  btnConvert: document.getElementById("btn-convert"),
  btnConvertLabel: document.getElementById("btn-convert-label"),
  btnCancel: document.getElementById("btn-cancel"),
  progressBlock: document.getElementById("progress-block"),
  progressTrack: document.getElementById("progress-track"),
  progressFill: document.getElementById("progress-fill"),
  progressLabel: document.getElementById("progress-label"),
  convertError: document.getElementById("convert-error"),

  resultBlock: document.getElementById("result-block"),
  resultName: document.getElementById("result-name"),
  resultSize: document.getElementById("result-size"),
  resultDuration: document.getElementById("result-duration"),
  btnSaveMp3: document.getElementById("btn-save-mp3"),
  btnNewConversion: document.getElementById("btn-new-conversion"),

  wave: document.querySelector(".wave"),
};

/* ---------- Estado da aplicação ------------------------------------------ */
const state = {
  file: null,
  fileExt: "",
  duration: null, // segundos, ou null se desconhecido
  saveHandle: null, // FileSystemFileHandle, quando disponível
  isConverting: false,
  ffmpeg: null, // instância carregada do FFmpeg
  ffmpegLoaded: false,
  supportsFsApi: "showSaveFilePicker" in window,
  lastObjectUrl: null,
};

/* =========================================================================
   Utilitários
   ========================================================================= */

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "tamanho desconhecido";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = -1;
  do {
    value /= 1024;
    unitIndex++;
  } while (value >= 1024 && unitIndex < units.length - 1);
  return `${value.toFixed(value < 10 ? 2 : 1)} ${units[unitIndex]}`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "não disponível";
  const totalSeconds = Math.round(seconds);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function getExtension(filename) {
  const parts = filename.split(".");
  if (parts.length < 2) return "";
  return parts.pop().toLowerCase();
}

function sanitizeFilename(name) {
  // Remove separadores de caminho e caracteres problemáticos em nomes de arquivo.
  let clean = name.replace(/[\\/:*?"<>|]/g, "").trim();
  if (!clean) clean = "audio";
  if (!/\.mp3$/i.test(clean)) clean += ".mp3";
  return clean;
}

function showFieldError(target, message) {
  target.textContent = message;
  target.hidden = false;
}

function hideFieldError(target) {
  target.hidden = true;
  target.textContent = "";
}

function setWaveAnimating(isAnimating) {
  el.wave.classList.toggle("animating", isAnimating);
}

/* =========================================================================
   Verificação de compatibilidade do navegador
   ========================================================================= */

function checkBrowserCompatibility() {
  if (typeof WebAssembly === "undefined") {
    el.incompatibleMessage.textContent =
      "Este navegador não tem suporte a WebAssembly, necessário para converter vídeos localmente. Atualize o navegador ou use uma versão recente do Chrome, Edge ou Firefox.";
    el.incompatibleBanner.hidden = false;
    el.btnConvert.disabled = true;
    el.btnChooseVideo.disabled = true;
    return false;
  }
  return true;
}

/* =========================================================================
   Seleção do vídeo
   ========================================================================= */

el.btnChooseVideo.addEventListener("click", () => {
  el.videoInput.click();
});

el.videoInput.addEventListener("change", async (event) => {
  const file = event.target.files && event.target.files[0];
  // Se o usuário cancelar a caixa de seleção, nenhum evento é disparado com
  // arquivo vazio de forma relevante aqui; apenas garantimos que nada quebre.
  if (!file) return;

  hideFieldError(el.fileError);

  const ext = getExtension(file.name);
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    showFieldError(
      el.fileError,
      `Formato ".${ext || "desconhecido"}" não suportado. Formatos aceitos: ${ALLOWED_EXTENSIONS.join(", ").toUpperCase()}.`
    );
    el.fileInfo.hidden = true;
    resetVideoState();
    return;
  }

  if (file.size === 0) {
    showFieldError(el.fileError, "Este arquivo parece estar vazio ou corrompido. Escolha outro vídeo.");
    resetVideoState();
    return;
  }

  state.file = file;
  state.fileExt = ext;
  state.duration = null;

  el.fileName.textContent = file.name;
  el.fileExt.textContent = ext.toUpperCase();
  el.fileSize.textContent = formatBytes(file.size);
  el.fileDuration.textContent = "calculando duração...";
  el.fileInfo.hidden = false;

  if (file.size > LARGE_FILE_WARNING_BYTES) {
    showFieldError(
      el.fileError,
      "Este arquivo é bastante grande. Dependendo da memória disponível no dispositivo, a conversão pode falhar ou demorar bastante."
    );
  }

  // Nome de saída sugerido
  const baseName = file.name.replace(/\.[^.]+$/, "");
  el.outputFilename.value = sanitizeFilename(baseName + ".mp3");

  updateConvertButtonState();
  await readVideoDuration(file);
});

function resetVideoState() {
  state.file = null;
  state.fileExt = "";
  state.duration = null;
  el.videoInput.value = "";
  updateConvertButtonState();
}

function readVideoDuration(file) {
  return new Promise((resolve) => {
    const videoEl = document.createElement("video");
    const url = URL.createObjectURL(file);
    let settled = false;

    const finish = (duration) => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      state.duration = Number.isFinite(duration) && duration > 0 ? duration : null;
      el.fileDuration.textContent = formatDuration(state.duration);
      resolve();
    };

    videoEl.preload = "metadata";
    videoEl.onloadedmetadata = () => finish(videoEl.duration);
    videoEl.onerror = () => finish(null);
    // Alguns contêineres (ex.: certos MKV/AVI) podem não ser decodificáveis
    // pelo elemento <video> do navegador, mesmo que o FFmpeg consiga lê-los.
    videoEl.src = url;

    // Failsafe: não travar a interface caso o evento nunca dispare.
    setTimeout(() => finish(null), 6000);
  });
}

/* =========================================================================
   Qualidade e nome do arquivo de saída
   ========================================================================= */

function getSelectedQuality() {
  const checked = document.querySelector('input[name="quality"]:checked');
  return checked ? checked.value : "192k";
}

el.outputFilename.addEventListener("blur", () => {
  el.outputFilename.value = sanitizeFilename(el.outputFilename.value || "audio");
});

/* =========================================================================
   Onde salvar (File System Access API / fallback)
   ========================================================================= */

function initSaveLocationUI() {
  if (state.supportsFsApi) {
    el.saveFsapiBlock.hidden = false;
    el.saveFallbackBlock.hidden = true;
  } else {
    el.saveFsapiBlock.hidden = true;
    el.saveFallbackBlock.hidden = false;
  }
}

el.btnChooseFolder.addEventListener("click", async () => {
  try {
    const suggestedName = sanitizeFilename(el.outputFilename.value || "audio");
    const handle = await window.showSaveFilePicker({
      suggestedName,
      types: [
        {
          description: "Áudio MP3",
          accept: { "audio/mpeg": [".mp3"] },
        },
      ],
    });
    state.saveHandle = handle;
    el.saveLocationStatus.textContent = `Local selecionado: ${handle.name}`;
    el.saveLocationStatus.hidden = false;
    // Mantém o nome do arquivo em sincronia com o escolhido no diálogo.
    el.outputFilename.value = handle.name;
  } catch (err) {
    if (err && err.name === "AbortError") {
      // Usuário cancelou o diálogo de salvamento: não é um erro, apenas
      // mantemos o estado anterior sem incomodar o usuário.
      return;
    }
    showFieldError(
      el.fileError,
      "Não foi possível abrir o seletor de local para salvar. Você ainda pode converter e usar o botão \"Salvar MP3\" ao final."
    );
  }
});

/* =========================================================================
   Habilitar/desabilitar botão converter
   ========================================================================= */

function updateConvertButtonState() {
  el.btnConvert.disabled = !state.file || state.isConverting;
}

/* =========================================================================
   Carregamento do FFmpeg (sob demanda, apenas na primeira conversão)
   ========================================================================= */

async function ensureFfmpegLoaded(onStatus) {
  if (state.ffmpegLoaded && state.ffmpeg) return state.ffmpeg;

  onStatus("Baixando mecanismo de conversão (primeira vez apenas)...");

  let FFmpeg, toBlobURL;
  try {
    const ffmpegModule = await import(/* webpackIgnore: true */ FFMPEG_JS_URL);
    const utilModule = await import(/* webpackIgnore: true */ FFMPEG_UTIL_URL);
    FFmpeg = ffmpegModule.FFmpeg;
    toBlobURL = utilModule.toBlobURL;
  } catch (err) {
    throw new AppError(
      "Não foi possível baixar o mecanismo de conversão. Verifique sua conexão com a internet e tente novamente."
    );
  }

  const ffmpeg = new FFmpeg();

  ffmpeg.on("log", () => {
    /* Silencioso: logs internos do FFmpeg não são exibidos ao usuário. */
  });

  try {
    const coreURL = await toBlobURL(`${FFMPEG_CORE_BASE}/ffmpeg-core.js`, "text/javascript");
    const wasmURL = await toBlobURL(`${FFMPEG_CORE_BASE}/ffmpeg-core.wasm`, "application/wasm");
    await ffmpeg.load({ coreURL, wasmURL });
  } catch (err) {
    throw new AppError(
      "Falha ao carregar o mecanismo de conversão (FFmpeg). Verifique sua conexão com a internet ou tente novamente em instantes."
    );
  }

  state.ffmpeg = ffmpeg;
  state.ffmpegLoaded = true;
  return ffmpeg;
}

class AppError extends Error {}

/* =========================================================================
   Conversão
   ========================================================================= */

el.btnConvert.addEventListener("click", startConversion);
el.btnCancel.addEventListener("click", cancelConversion);

async function startConversion() {
  if (!state.file || state.isConverting) return;

  hideFieldError(el.convertError);
  state.isConverting = true;
  updateConvertButtonState();
  el.btnCancel.hidden = false;
  el.btnConvertLabel.textContent = "Convertendo...";
  el.progressBlock.hidden = false;
  setProgress(0, "Preparando...");
  setWaveAnimating(true);

  const inputName = `input.${state.fileExt || "mp4"}`;
  const outputFilename = sanitizeFilename(el.outputFilename.value || "audio");
  const outputName = "output.mp3";
  const quality = getSelectedQuality();

  try {
    const ffmpeg = await ensureFfmpegLoaded((msg) => setProgress(0, msg));

    const utilModule = await import(/* webpackIgnore: true */ FFMPEG_UTIL_URL);
    const { fetchFile } = utilModule;

    setProgress(2, "Carregando vídeo na memória...");
    const inputData = await fetchFile(state.file);
    await ffmpeg.writeFile(inputName, inputData);

    let lastPercent = 2;
    const onProgress = ({ progress }) => {
      if (!Number.isFinite(progress)) return;
      const percent = Math.max(0, Math.min(100, Math.round(progress * 100)));
      if (percent >= lastPercent) {
        lastPercent = percent;
        setProgress(percent, `Convertendo... ${percent}%`);
      }
    };
    ffmpeg.on("progress", onProgress);

    setProgress(lastPercent, "Extraindo e codificando áudio...");
    await ffmpeg.exec(["-i", inputName, "-vn", "-b:a", quality, "-y", outputName]);

    ffmpeg.off("progress", onProgress);
    setProgress(100, "Finalizando...");

    const data = await ffmpeg.readFile(outputName);
    const mp3Blob = new Blob([data.buffer], { type: "audio/mpeg" });

    // Limpeza dos arquivos temporários na memória virtual do FFmpeg.
    try {
      await ffmpeg.deleteFile(inputName);
      await ffmpeg.deleteFile(outputName);
    } catch (_) {
      /* Não crítico se a limpeza falhar. */
    }

    await handleConversionResult(mp3Blob, outputFilename);
  } catch (err) {
    handleConversionError(err);
  } finally {
    state.isConverting = false;
    updateConvertButtonState();
    el.btnCancel.hidden = true;
    el.btnConvertLabel.textContent = "Converter para MP3";
    el.progressBlock.hidden = true;
    setWaveAnimating(false);
  }
}

function setProgress(percent, label) {
  el.progressFill.style.width = `${percent}%`;
  el.progressTrack.setAttribute("aria-valuenow", String(percent));
  el.progressLabel.textContent = label;
}

async function cancelConversion() {
  if (!state.isConverting) return;
  try {
    if (state.ffmpeg) {
      state.ffmpeg.terminate();
    }
  } catch (_) {
    /* Ignorado: o objetivo é apenas garantir que o estado seja resetado. */
  }
  // Após terminate(), a instância não pode ser reaproveitada.
  state.ffmpeg = null;
  state.ffmpegLoaded = false;
  state.isConverting = false;
  el.progressBlock.hidden = true;
  el.btnCancel.hidden = true;
  el.btnConvertLabel.textContent = "Converter para MP3";
  setWaveAnimating(false);
  updateConvertButtonState();
  showFieldError(el.convertError, "Conversão cancelada.");
}

function handleConversionError(err) {
  let message = "Ocorreu um erro inesperado durante a conversão. Tente novamente.";

  if (err instanceof AppError) {
    message = err.message;
  } else if (err && typeof err.message === "string") {
    const msg = err.message.toLowerCase();
    if (msg.includes("out of memory") || msg.includes("oom") || msg.includes("memory access")) {
      message = "O navegador ficou sem memória para processar este vídeo. Tente um arquivo menor, feche outras abas ou use um dispositivo com mais memória disponível.";
    } else if (msg.includes("invalid data") || msg.includes("moov atom") || msg.includes("could not find codec")) {
      message = "Não foi possível ler o áudio deste vídeo. O arquivo pode estar corrompido ou usar um formato/codec não suportado.";
    } else if (msg.includes("fetch") || msg.includes("network")) {
      message = "Falha de conexão ao carregar o mecanismo de conversão. Verifique sua internet e tente novamente.";
    }
  }

  showFieldError(el.convertError, message);
}

/* =========================================================================
   Resultado e salvamento
   ========================================================================= */

async function handleConversionResult(blob, filename) {
  let savedAutomatically = false;

  if (state.saveHandle) {
    try {
      const writable = await state.saveHandle.createWritable();
      await writable.write(blob);
      await writable.close();
      savedAutomatically = true;
    } catch (err) {
      savedAutomatically = false;
      showFieldError(
        el.convertError,
        "O MP3 foi gerado, mas não foi possível salvá-lo automaticamente no local escolhido. Use o botão \"Salvar MP3\" abaixo."
      );
    }
  }

  if (state.lastObjectUrl) {
    URL.revokeObjectURL(state.lastObjectUrl);
  }
  state.lastObjectUrl = URL.createObjectURL(blob);

  el.resultName.textContent = filename;
  el.resultSize.textContent = formatBytes(blob.size);
  el.resultDuration.textContent = formatDuration(state.duration);

  el.btnSaveMp3.hidden = savedAutomatically;
  el.btnSaveMp3.onclick = () => downloadBlob(state.lastObjectUrl, filename);

  el.resultBlock.hidden = false;
  el.resultBlock.scrollIntoView({ behavior: "smooth", block: "start" });
}

function downloadBlob(url, filename) {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

/* =========================================================================
   Nova conversão
   ========================================================================= */

el.btnNewConversion.addEventListener("click", () => {
  resetVideoState();
  state.saveHandle = null;

  el.fileInfo.hidden = true;
  hideFieldError(el.fileError);
  hideFieldError(el.convertError);
  el.saveLocationStatus.hidden = true;
  el.outputFilename.value = "";
  el.resultBlock.hidden = true;

  if (state.lastObjectUrl) {
    URL.revokeObjectURL(state.lastObjectUrl);
    state.lastObjectUrl = null;
  }

  document.querySelector('input[name="quality"][value="192k"]').checked = true;
  window.scrollTo({ top: 0, behavior: "smooth" });
});

/* =========================================================================
   Inicialização
   ========================================================================= */

function init() {
  const compatible = checkBrowserCompatibility();
  initSaveLocationUI();
  updateConvertButtonState();
  if (!compatible) return;
}

init();
