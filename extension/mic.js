// Pede a permissão de microfone para a extensão. O documento invisível do gravador
// não consegue mostrar esse pedido, então ele acontece aqui, numa aba normal, uma vez só:
// depois de concedida, a permissão vale para o gravador também (mesma origem).
const status = document.getElementById("status");

async function ask() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) track.stop();
    status.textContent = "Permissão concedida. Começando a gravar…";
    // Se o popup deixou um pedido de gravação guardado, ela começa agora e a aba da reunião volta ao primeiro plano.
    const res = await chrome.runtime.sendMessage({ type: "mic-granted" }).catch(() => null);
    if (res?.ok) {
      status.textContent = "Gravando. Voltando para a reunião…";
      setTimeout(() => window.close(), 800);
    } else if (!res || res.code === "none") {
      status.textContent = "Pronto! Pode fechar esta aba e gravar a reunião pelo ícone do Escuta.";
      setTimeout(() => window.close(), 1500);
    } else {
      status.textContent = res.message || "Permissão concedida, mas não consegui começar a gravar. Volte à reunião e grave pelo ícone do Escuta.";
    }
  } catch (err) {
    status.textContent =
      err.name === "NotAllowedError"
        ? "Permissão negada. Clique no cadeado ao lado do endereço, permita o microfone e recarregue esta página."
        : `Não consegui acessar o microfone (${err.name}).`;
  }
}

ask();
