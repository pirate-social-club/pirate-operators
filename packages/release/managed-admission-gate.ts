import type { Hex } from "viem";
import type { ReservationCondition } from "../community/budgets.ts";
import type { OwnerBudgetAsset, OwnerBudgetGrant } from "./owner-grant.ts";

/** Private authenticated service composition, never a wire/grant field.
 * The implementation captures admission reference, selection digest, original
 * registration revision, community and publisher and checks the exact parsed
 * grant on both methods. Health is not admission.
 *
 * reservationCondition must bind the active original admission/revision AND
 * current database time in the same D1 transaction as the owner reservation.
 * An async precheck alone is insufficient. Existing identical reservations
 * and read/status/settlement do not invoke this NEW-effect capability.
 */
export interface ManagedAdmissionGate {
  reservationCondition(
    grant: Readonly<OwnerBudgetGrant>,
    original: Readonly<{operationId:string;requestHash:Hex;asset:OwnerBudgetAsset;requested:string}>,
  ): Promise<ReservationCondition>;
  beforeDispatch(
    grant: Readonly<OwnerBudgetGrant>,
    original: Readonly<{operationId:string;requestHash:Hex}>,
  ): Promise<void>;
}
