import { AppProviders } from "./AppProviders";
import { CandorWorkspace } from "./CandorWorkspace";

export function CandorApp() {
  return (
    <AppProviders>
      <CandorWorkspace />
    </AppProviders>
  );
}

export default CandorApp;

