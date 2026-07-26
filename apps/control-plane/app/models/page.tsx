import { ConsoleGate } from "@/components/console/console-gate";
import { ModelsConsole } from "@/components/models/models-console";

export default function ModelsPage() {
  return (
    <ConsoleGate minRole="viewer">
      <ModelsConsole />
    </ConsoleGate>
  );
}
