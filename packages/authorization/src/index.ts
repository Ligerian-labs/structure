/**
 * `@structure-ai/authorization` — typed role/permission matrices (RBAC with
 * conditional grants and scoped role assignments), principal propagation on
 * the fiber, and guards for plain effects, CQRS dispatch and HTTP requests.
 * Authentication is someone else's job: build a `Principal` once a caller is
 * identified, attach it with `Principal.within`, check against the policy.
 */
export { Condition, type ConditionContext } from "./condition.js";
export {
  CqrsAuthorization,
  type CqrsAuthorizationOptions,
  CqrsAuthorizationRules,
  type MessageRule,
  type PayloadOf,
  type Requirement,
} from "./cqrs.js";
export {
  type AuthorizationError,
  InvalidPolicy,
  PermissionDenied,
  Unauthenticated,
} from "./errors.js";
export * as HttpAuthorization from "./http.js";
export {
  type CheckOptions,
  type ConditionalGrant,
  type Decision,
  type Grant,
  type Guard,
  type MatrixCell,
  Policy,
  type PolicyDefinition,
  PolicyDefinitionSchema,
  type PolicyMatrix,
  type PolicyPermission,
  type PolicyRole,
  type ResolvedGrant,
  type ResourceDefinitions,
  type ResourceGrant,
  type ResourcePermission,
  type RoleDefinition,
} from "./policy.js";
export { Principal, type RoleAssignment } from "./principal.js";
export { Authorization, type AuthorizationService } from "./service.js";
