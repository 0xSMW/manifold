import { ConsoleGate } from "@/components/console/console-gate";
import { AuditConsole } from "@/components/audit/audit-console";

export default function AuditPage() {
  return (
    <ConsoleGate enterpriseOnly minRole="viewer">
      <AuditConsole />
    </ConsoleGate>
  );
}
