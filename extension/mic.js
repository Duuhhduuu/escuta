// Pede a permissão de microfone para a extensão. O documento invisível do gravador
// não consegue mostrar esse pedido, então ele acontece aqui, numa aba normal, uma vez só:
// depois de concedida, a permissão vale para o gravador também (mesma origem).
const status = document.getElementById("status");

async function ask() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) track.stop();
    status.textContent = "Pronto! Pode fechar esta aba e gravar a reunião.";
    setTimeout(() => window.close(), 1500);
  } catch (err) {
    status.textContent =
      err.name === "NotAllowedError"
        ? "Permissão negada. Clique no cadeado ao lado do endereço, permita o microfone e recarregue esta página."
        : `Não consegui acessar o microfone (${err.name}).`;
  }
}

ask();
