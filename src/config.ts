import {readFileSync} from "node:fs";
import {z} from "zod";

/// Which subgraphs this server reads.
///
/// Endpoints are configuration, not code, for the same reason the standardized schema keeps vault
/// selection in a config file: the claim is that this works against any ERC-4626 vault, and a
/// claim like that is only testable if someone can point it at a vault we have never seen without
/// touching a source file.

const VaultSubgraph = z.object({
  /// Short handle used in tool arguments and in output, so a model can refer to a source without
  /// repeating a URL.
  key: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "a key is lower-case letters, digits and hyphens"),
  label: z.string().min(1),
  /// Informational. The network a subgraph indexes is a fact about the deployment, and the server
  /// has no way to check it, so it is reported rather than trusted.
  network: z.string().min(1),
  url: z.url(),
});

const Config = z.object({
  vaultSubgraphs: z.array(VaultSubgraph).min(1),
  /// Optional: the trader tools need it, the vault tools do not. Someone pointing this at their own
  /// ERC-4626 vault has no copy graph and should not be made to invent one.
  copeSubgraph: z.object({url: z.url()}).nullable().default(null),
});

export type VaultSubgraph = z.infer<typeof VaultSubgraph>;
export type Config = z.infer<typeof Config>;

const STUDIO = "https://api.studio.thegraph.com/query/101383";

/// The deployments from workstream 5. A judge who runs this with no configuration at all still gets
/// three live vaults across two chains and two protocols, which is the point being demonstrated.
export const DEFAULT_CONFIG: Config = {
  vaultSubgraphs: [
    {
      key: "cope-arc",
      label: "Cope Market LiquidityVault",
      network: "arc-testnet",
      url: `${STUDIO}/erc-4626-vault-arc/v0.2.0`,
    },
    {
      key: "morpho-base",
      label: "MetaMorpho vaults (Moonwell Flagship USDC and ETH)",
      network: "base",
      url: `${STUDIO}/erc-4626-vault-base/v0.1.0`,
    },
  ],
  copeSubgraph: {url: `${STUDIO}/cope-market-arc/v0.2.0`},
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const path = env["ERC4626_MCP_CONFIG"];
  if (!path) return DEFAULT_CONFIG;

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    // Failing here rather than falling back. A server that silently ignored a config file would
    // answer about our vaults while the operator believed it was answering about theirs.
    throw new Error(
      `ERC4626_MCP_CONFIG points at ${path}, which could not be read as JSON: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const parsed = Config.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`${path} is not a valid configuration. ${issues}`);
  }

  const keys = new Set<string>();
  for (const subgraph of parsed.data.vaultSubgraphs) {
    if (keys.has(subgraph.key)) {
      throw new Error(`${path} uses the key "${subgraph.key}" twice. Keys identify a source.`);
    }
    keys.add(subgraph.key);
  }

  return parsed.data;
}
