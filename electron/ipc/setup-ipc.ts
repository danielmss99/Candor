import { ipcMain } from "electron";
import {
  isSetupStep,
  type DesktopPreferencesService,
} from "../preferences/desktop-preferences.js";
import { validateIpcSender, type MainWindowProvider } from "../security/validate-sender.js";

export const SETUP_IPC_CHANNELS = Object.freeze({
  getStatus: "candor-setup:getStatus",
  visit: "candor-setup:visit",
  updateStep: "candor-setup:updateStep",
  defer: "candor-setup:defer",
  complete: "candor-setup:complete",
  markExistingUserPromptShown: "candor-setup:markExistingUserPromptShown",
});

type IpcListener = (...args: any[]) => unknown;

export interface IpcHandlerRegistrar {
  handle(channel: string, listener: IpcListener): void;
  removeHandler(channel: string): void;
}

export interface SetupIpcDependencies {
  preferences: Pick<DesktopPreferencesService, "status" | "visitStep" | "updateStep" | "deferStep" | "completeSetup" | "markExistingUserPromptShown">;
  getMainWindow: MainWindowProvider;
  ipc?: IpcHandlerRegistrar;
  validateSender?: typeof validateIpcSender;
}

function strictObject(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Setup request must be an object.");
  }
  const object = value as Record<string, unknown>;
  const allowed = new Set(fields);
  if (Object.keys(object).some((field) => !allowed.has(field))) {
    throw new Error("Setup request contains an unsupported field.");
  }
  return object;
}

function stepInput(value: unknown): { step: ReturnType<typeof checkedStep>; visit: ReturnType<typeof checkedStep> | null } {
  const object = strictObject(value, ["step", "visit"]);
  return {
    step: checkedStep(object.step),
    visit: object.visit === undefined ? null : checkedStep(object.visit),
  };
}

function deferInput(value: unknown): { step: ReturnType<typeof checkedStep> } {
  const object = strictObject(value, ["step"]);
  return { step: checkedStep(object.step) };
}

function checkedStep(value: unknown) {
  if (!isSetupStep(value)) throw new Error("Setup step is invalid.");
  return value;
}

export function registerSetupIpc(dependencies: SetupIpcDependencies): () => void {
  const registrar = dependencies.ipc ?? ipcMain as unknown as IpcHandlerRegistrar;
  const validateSender = dependencies.validateSender ?? validateIpcSender;

  registrar.handle(SETUP_IPC_CHANNELS.getStatus, async (event) => {
    validateSender(event, dependencies.getMainWindow);
    return dependencies.preferences.status();
  });
  registrar.handle(SETUP_IPC_CHANNELS.visit, async (event, value) => {
    validateSender(event, dependencies.getMainWindow);
    const { step } = deferInput(value);
    return dependencies.preferences.visitStep(step);
  });
  registrar.handle(SETUP_IPC_CHANNELS.updateStep, async (event, value) => {
    validateSender(event, dependencies.getMainWindow);
    const { step, visit } = stepInput(value);
    return dependencies.preferences.updateStep(step, visit);
  });
  registrar.handle(SETUP_IPC_CHANNELS.defer, async (event, value) => {
    validateSender(event, dependencies.getMainWindow);
    const { step } = deferInput(value);
    return dependencies.preferences.deferStep(step);
  });
  registrar.handle(SETUP_IPC_CHANNELS.complete, async (event) => {
    validateSender(event, dependencies.getMainWindow);
    return dependencies.preferences.completeSetup();
  });
  registrar.handle(SETUP_IPC_CHANNELS.markExistingUserPromptShown, async (event) => {
    validateSender(event, dependencies.getMainWindow);
    return dependencies.preferences.markExistingUserPromptShown();
  });

  return () => {
    Object.values(SETUP_IPC_CHANNELS).forEach((channel) => registrar.removeHandler(channel));
  };
}
