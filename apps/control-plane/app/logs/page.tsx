import { ConsoleGate } from "@/components/console/console-gate";
import { LogsConsole } from "@/components/logs/logs-console";

export default function LogsPage() {
  return <ConsoleGate minRole="viewer"><LogsConsole /></ConsoleGate>;
}
