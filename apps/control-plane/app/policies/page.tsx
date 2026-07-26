import { ConsoleGate } from "@/components/console/console-gate";
import { PoliciesConsole } from "@/components/policies/policies-console";

export default function PoliciesPage() {
  return <ConsoleGate enterpriseOnly minRole="editor"><PoliciesConsole /></ConsoleGate>;
}
