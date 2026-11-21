/**
 * Vitest setup file (setupFiles in vitest.config.mts): registers jest-dom matchers such as
 * toBeInTheDocument / toHaveAccessibleName, unmounts rendered trees after each test, and
 * polyfills the <dialog> methods jsdom lacks.
 */
import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Unmount everything the previous test rendered so queries never see stale DOM.
afterEach(() => cleanup());

// jsdom lacks these browser APIs used by the UI.
// Minimal stand-ins: showModal/close only toggle the open attribute (no focus trap or backdrop).
if (typeof HTMLDialogElement !== "undefined" && !HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute("open");
  };
}
