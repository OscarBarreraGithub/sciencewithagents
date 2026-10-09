export type MemberService = {
  version: 1;
  mode: 'hosted';
  endpoint: string;
  endpointId: string;
  hostingAuthorization: { origin: string; approvalCapability: string; freeApprovalId: string };
};
export type OwnerService = MemberService & { setupCapability: string };
export const uuid: RegExp;
export const hex: RegExp;
export class SetupError extends Error {}
export function exists(path: string): boolean;
export function privateDirectory(path: string): void;
export function privateRead(path: string): string;
export function privateWrite(path: string, value: unknown): void;
export function publicOrigin(value: string): string;
export function memberService(value: unknown): MemberService;
export function ownerService(value: unknown): OwnerService;
export function groupServiceHash(value: unknown): string;
export function readRegistryService(
  directory: string,
  serviceHash: string,
  creator?: boolean,
): MemberService | OwnerService | null;
export function readCreatorService(directory: string): OwnerService | null;
export function currentCreatorService(directory: string): OwnerService | null;
export function registerService(directory: string, value: unknown): string;
export function installService(directory: string, value: unknown, creator?: boolean): void;

export function withServiceSetup<T>(directory: string, work: () => T): T;
