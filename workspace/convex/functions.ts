import { internalMutationGeneric, mutationGeneric, queryGeneric } from "convex/server";
import type { DataModelFromSchemaDefinition, MutationBuilder, QueryBuilder } from "convex/server";
import type schema from "./schema";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
export const query: QueryBuilder<DataModel, "public"> = queryGeneric;
export const mutation: MutationBuilder<DataModel, "public"> = mutationGeneric;
export const internalMutation: MutationBuilder<DataModel, "internal"> = internalMutationGeneric;
