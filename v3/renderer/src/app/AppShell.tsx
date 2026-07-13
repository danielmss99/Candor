import type { ComponentProps } from "react";
import { DesktopShell } from "../components/DesktopShell";

export type AppShellProps = ComponentProps<typeof DesktopShell>;

export function AppShell(props: AppShellProps) {
  return <DesktopShell {...props} />;
}

