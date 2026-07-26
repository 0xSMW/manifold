import { ConsoleGate } from "@/components/console/console-gate";
import { KeysConsole } from "@/components/keys/keys-console";

export default function KeysPage() {
  return (
    <ConsoleGate minRole="editor">
      <KeysConsole />
    </ConsoleGate>
  );
}
