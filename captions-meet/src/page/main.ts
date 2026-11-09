// Ponto de entrada do mundo da página (world MAIN, document_start). O que o gancho pega sai por postMessage para o
// content script, com uma etiqueta que ele confere.
import { installHook } from "./hook.ts";
import { SOURCE } from "../shared.ts";

const guard = window as unknown as { __escutaLegendas?: boolean };
if (!guard.__escutaLegendas) {
  guard.__escutaLegendas = true;
  installHook(window, (event) => window.postMessage({ source: SOURCE, ...event }, location.origin));
}
