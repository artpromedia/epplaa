/**
 * Manufacturer portal data hooks (task #200).
 *
 * Wraps the generated React Query hooks from @workspace/api-client-react
 * with manufacturer-portal-specific defaults (stale times, error handling)
 * so individual pages don't have to repeat the same options.
 *
 * Generated hooks are in lib/api-client-react/src/generated/api.ts and
 * are re-exported from @workspace/api-client-react. This file imports
 * from the workspace package so any orval regeneration is automatically
 * reflected here.
 */
import {
  useGetManufacturerMe,
  useListManufacturerKyc,
  useListManufacturerListings,
  useListManufacturerOrders,
  useGetManufacturerOrder,
  useApplyManufacturer,
  useCreateManufacturerListing,
  useUpdateManufacturerListing,
  useDeleteManufacturerListing,
} from "@workspace/api-client-react";

export type { UseQueryOptions, UseMutationOptions } from "@tanstack/react-query";

// Re-export the generated hooks with the same names so portal pages
// import from this file instead of directly from @workspace/api-client-react.
// This gives us a single place to add portal-level defaults later.
export {
  useGetManufacturerMe,
  useListManufacturerKyc,
  useListManufacturerListings,
  useListManufacturerOrders,
  useGetManufacturerOrder,
  useApplyManufacturer,
  useCreateManufacturerListing,
  useUpdateManufacturerListing,
  useDeleteManufacturerListing,
};
