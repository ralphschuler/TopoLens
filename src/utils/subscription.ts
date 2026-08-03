export interface RisSubscription {
  collector: string;
  prefix: string;
  path: string;
}

export interface RisSubscribePayload {
  host: string;
  type: "UPDATE";
  prefix?: string;
  moreSpecific?: boolean;
  path?: number | string;
  socketOptions: {
    acknowledge: true;
    includeRaw: false;
  };
}

export const DEFAULT_RIS_SUBSCRIPTION: RisSubscription = {
  collector: "rrc00",
  prefix: "",
  path: "",
};

export function normalizeRisSubscription(subscription: RisSubscription): RisSubscription {
  return {
    collector: subscription.collector.trim().toLowerCase(),
    prefix: subscription.prefix.trim(),
    path: subscription.path.trim(),
  };
}

function isValidIpv4Prefix(value: string): boolean {
  const [address, lengthText, extra] = value.split("/");
  if (extra !== undefined || !address || lengthText === undefined) return false;

  const octets = address.split(".");
  if (octets.length !== 4) return false;
  if (
    octets.some((octet) => !/^\d{1,3}$/.test(octet) || Number(octet) < 0 || Number(octet) > 255)
  ) {
    return false;
  }

  const length = Number(lengthText);
  return Number.isInteger(length) && length >= 0 && length <= 32;
}

function isValidIpv6Prefix(value: string): boolean {
  const [address, lengthText, extra] = value.split("/");
  if (extra !== undefined || !address || lengthText === undefined) return false;
  if (!address.includes(":") || !/^[0-9a-fA-F:.]+$/.test(address)) return false;

  const length = Number(lengthText);
  return Number.isInteger(length) && length >= 0 && length <= 128;
}

function isValidPathFilter(value: string): boolean {
  if (!value) return true;
  if (/^\d+$/.test(value)) {
    const asn = Number(value);
    return Number.isSafeInteger(asn) && asn >= 0 && asn <= 4_294_967_295;
  }

  return /^!?\^?[0-9,[\]]+\$?$/.test(value);
}

export function validateRisSubscription(subscription: RisSubscription): string {
  const normalized = normalizeRisSubscription(subscription);
  const errors: string[] = [];

  if (!/^rrc\d{2}(?:\.ripe\.net)?$/.test(normalized.collector)) {
    errors.push("Enter a valid RIPE collector such as rrc00 or rrc21.");
  }

  if (
    normalized.prefix &&
    !isValidIpv4Prefix(normalized.prefix) &&
    !isValidIpv6Prefix(normalized.prefix)
  ) {
    errors.push("Enter the prefix in IPv4 or IPv6 CIDR notation.");
  }

  if (!isValidPathFilter(normalized.path)) {
    errors.push("Enter an ASN or a valid RIS AS path pattern.");
  }

  return errors.join(" ");
}

export function buildRisSubscriptionPayload(subscription: RisSubscription): RisSubscribePayload {
  const normalized = normalizeRisSubscription(subscription);
  const payload: RisSubscribePayload = {
    host: normalized.collector,
    type: "UPDATE",
    socketOptions: {
      acknowledge: true,
      includeRaw: false,
    },
  };

  if (normalized.prefix) {
    payload.prefix = normalized.prefix;
    payload.moreSpecific = true;
  }

  if (normalized.path) {
    payload.path = /^\d+$/.test(normalized.path) ? Number(normalized.path) : normalized.path;
  }

  return payload;
}
