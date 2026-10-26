// First run: no connections yet.
import { Button } from "@mantine/core";
import { IconCertificate, IconKey, IconPlus, IconServer2 } from "@tabler/icons-react";
import { Shortcut, useShell } from "../design";
import { secretStore } from "../lib/platform";
import appIcon from "../assets/app-icon.png";

export default function Welcome() {
  const shell = useShell();
  const store = secretStore();
  return (
    <div className="sem-welcome" data-testid="welcome">
      <img src={appIcon} alt="" className="sem-welcome-icon" width={96} height={96} />
      <h1 className="sem-welcome-title">Add your first SoftEther server</h1>
      <p className="sem-welcome-text">
        Connect to a SoftEther VPN Server with its host name and administrator password, exactly as you would in Server Manager.
        You can add as many servers as you like and manage them side by side.
      </p>
      <Button size="md" leftSection={<IconPlus size={16} />} onClick={() => shell.openConnection()} data-testid="welcome-add">
        Add Connection…
      </Button>
      <div className="sem-welcome-hint">or press <Shortcut keys={["mod", "N"]} /></div>
      <ul className="sem-welcome-points">
        <li><IconServer2 size={18} stroke={1.5} /><div><b>Server or hub administrator</b><span>Use the server password for everything, or a hub’s password to manage just that hub.</span></div></li>
        <li><IconCertificate size={18} stroke={1.5} /><div><b>Verified connections</b><span>You confirm the server’s certificate once; any later change is refused.</span></div></li>
        <li><IconKey size={18} stroke={1.5} /><div><b>Passwords stay on this computer</b><span>Saved passwords are {store.long}. Or don’t save them and unlock when needed.</span></div></li>
      </ul>
    </div>
  );
}
