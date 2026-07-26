import { AccountConsole } from "@/components/account/account-console";
import { ConsoleGate } from "@/components/console/console-gate";

export default function AccountPage() {
  return <ConsoleGate minRole="billing"><AccountConsole /></ConsoleGate>;
}
