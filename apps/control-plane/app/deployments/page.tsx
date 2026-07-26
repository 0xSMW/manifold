import { ConsoleGate } from "@/components/console/console-gate";
import { DeploymentsConsole } from "@/components/deployments/deployments-console";

export default function DeploymentsPage() {
  return (
    <ConsoleGate minRole="admin">
      <DeploymentsConsole />
    </ConsoleGate>
  );
}
