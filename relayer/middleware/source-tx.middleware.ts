/// <reference lib="dom" />
import { Middleware } from "../compose.middleware";
import { Context } from "../context";
import { sleep } from "../utils";
import { ChainId, isEVMChain } from "@certusone/wormhole-sdk";
import { Logger } from "winston";
import { Environment } from "../environment";
import { LRUCache } from "lru-cache";

export interface SourceTxOpts {
  wormscanEndpoint: string;
  retries: number;
}

export interface SourceTxContext extends Context {
  sourceTxHash?: string;
}

export const wormscanEndpoints: { [k in Environment]: string | undefined } = {
  [Environment.MAINNET]: "https://api.wormscan.io",
  [Environment.TESTNET]: "https://api.testnet.wormscan.io",
  [Environment.DEVNET]: undefined,
};

const defaultOptsByEnv: { [k in Environment]: Partial<SourceTxOpts> } = {
  [Environment.MAINNET]: {
    wormscanEndpoint: wormscanEndpoints[Environment.MAINNET],
    retries: 5,
  },
  [Environment.TESTNET]: {
    wormscanEndpoint: wormscanEndpoints[Environment.TESTNET],
    retries: 3,
  },
  [Environment.DEVNET]: {
    wormscanEndpoint: wormscanEndpoints[Environment.DEVNET],
    retries: 3,
  },
};

export function sourceTx(
  optsWithoutDefaults?: SourceTxOpts,
): Middleware<SourceTxContext> {
  let opts: SourceTxOpts;
  const alreadyFetchedHashes = new LRUCache({ max: 100 });

  return async (ctx, next) => {
    if (!opts) {
      // initialize options now that we know the environment from context
      opts = Object.assign({}, defaultOptsByEnv[ctx.env], optsWithoutDefaults);
    }
    const vaaId = `${ctx.vaa.id.emitterChain}-${ctx.vaa.id.emitterAddress}-${ctx.vaa.id.sequence}`;
    const txHashFromCache = alreadyFetchedHashes.get(vaaId) as
      | string
      | undefined;

    if (txHashFromCache) {
      ctx.logger?.debug(`Already fetched tx hash: ${txHashFromCache}`);
      ctx.sourceTxHash = txHashFromCache;
      await next();
      return;
    }

    const { emitterChain, emitterAddress, sequence } = ctx.vaa;
    ctx.logger?.debug("Fetching tx hash...");
    let txHash = await fetchVaaHash(
      emitterChain,
      emitterAddress,
      sequence,
      ctx.logger,
      ctx.env,
      opts.retries,
      opts.wormscanEndpoint,
    );
    if (txHash === "") {
      ctx.logger?.debug("Could not retrive tx hash.");
    } else {
      // TODO look at consistency level before using cache? (not sure what the checks are)
      alreadyFetchedHashes.set(vaaId, txHash);
      ctx.logger?.debug(`Retrieved tx hash: ${txHash}`);
    }
    ctx.sourceTxHash = txHash;
    await next();
  };
}

export async function fetchVaaHash(
  emitterChain: number,
  emitterAddress: Buffer,
  sequence: bigint,
  logger: Logger,
  env: Environment,
  retries: number = 3,
  baseEndpoint: string = wormscanEndpoints[env],
) {
  let attempt = 0;
  let txHash = "";
  do {
    try {
      const res = await fetch(
        `${baseEndpoint}/api/v1/vaas/${emitterChain}/${emitterAddress.toString(
          "hex",
        )}/${sequence.toString()}`,
      );
      if (res.status === 404) {
        throw new Error("Not found yet.");
      } else if (res.status > 500) {
        throw new Error(`Got: ${res.status}`);
      }
      txHash = (await res.json()).data?.txHash;
    } catch (e) {
      logger?.error(
        `could not obtain txHash, attempt: ${attempt} of ${retries}.`,
        e,
      );
      await sleep((attempt + 1) * 200); // linear wait
    }
  } while (++attempt < retries && !txHash);

  if (
    isEVMChain(emitterChain as ChainId) &&
    txHash &&
    !txHash.startsWith("0x")
  ) {
    txHash = `0x${txHash}`;
  }

  logger.debug("Source Transaction Hash: " + txHash || "Not Found");

  return txHash;
}
