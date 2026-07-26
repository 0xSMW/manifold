import { ConsoleGate } from "@/components/console/console-gate";
import { RoutesConsole } from "@/components/routes/routes-console";

export default function RoutesPage() {
  return (
    <ConsoleGate minRole="editor">
      <RoutesConsole />
    </ConsoleGate>
  );
}
