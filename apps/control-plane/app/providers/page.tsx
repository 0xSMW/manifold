import { ConsoleGate } from "@/components/console/console-gate";
import { ProvidersConsole } from "@/components/providers/providers-console";

export default function ProvidersPage() {
  return (
    <ConsoleGate minRole="editor">
      <ProvidersConsole />
    </ConsoleGate>
  );
}
