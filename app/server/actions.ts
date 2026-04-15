import { createServerFn } from "@tanstack/react-start";

import {
	accountIdInputSchema,
	beginGoogleConnectInputSchema,
	beginGoogleReconnectInputSchema,
	classifyOneInputSchema,
	completeGoogleConnectInputSchema,
	enqueueOverseerInputSchema,
	financeArtifactImportInputSchema,
	financeDataInputSchema,
	purgeAccountInputSchema,
	resolveReviewInputSchema,
} from "#/lib/schemas";

import {
	beginGoogleConnectCommand,
	beginGoogleReconnectCommand,
	classifyOneNowCommand,
	completeGoogleConnectCommand,
	disconnectAccountCommand,
	enqueueOverseerCommand,
	loadAccountDetailData,
	loadAccountDeleteData,
	loadAccountNewData,
	loadAccountReconnectData,
	loadAccountsData,
	loadFinanceData,
	loadHomeData,
	loadMessageDetailData,
	loadMessagesData,
	loadProfileData,
	loadReviewData,
	loadRunsData,
	pauseAccountSyncCommand,
	purgeAccountCommand,
	queueAccountClassifyBacklogCommand,
	queueAccountDeltaSyncCommand,
	queueAccountFinanceBacklogCommand,
	queueAccountFullSyncCommand,
	queueAccountReconcileCommand,
	queueImportFinanceArtifactCommand,
	queueImportOperatorRegistryCommand,
	queueRebuildFinanceKnowledgeCommand,
	queueRebuildFinanceRollupsCommand,
	queueReclassifyFinanceBacklogCommand,
	queueReclassifyRootBacklogCommand,
	queueReconcileRegistrySuggestionsCommand,
	resolveReviewCommand,
	resumeAccountSyncCommand,
} from "./actions.server";

export const getHomeData = createServerFn({ method: "GET" }).handler(
	loadHomeData,
);

export const getMessagesData = createServerFn({ method: "GET" }).handler(
	loadMessagesData,
);

export const getMessageDetailData = createServerFn({
	method: "GET",
})
	.inputValidator(classifyOneInputSchema)
	.handler(async ({ data }) => loadMessageDetailData(data));

export const getReviewData = createServerFn({ method: "GET" }).handler(
	loadReviewData,
);

export const getRunsData = createServerFn({ method: "GET" }).handler(
	loadRunsData,
);

export const getProfileData = createServerFn({
	method: "GET",
})
	.inputValidator(enqueueOverseerInputSchema.pick({ accountId: true }))
	.handler(async ({ data }) => loadProfileData(data));

export const getFinanceData = createServerFn({ method: "GET" })
	.inputValidator(financeDataInputSchema)
	.handler(async ({ data }) => loadFinanceData(data));

export const enqueueOverseer = createServerFn({
	method: "POST",
})
	.inputValidator(enqueueOverseerInputSchema)
	.handler(async ({ data }) => enqueueOverseerCommand(data));

export const resolveReview = createServerFn({
	method: "POST",
})
	.inputValidator(resolveReviewInputSchema)
	.handler(async ({ data }) => resolveReviewCommand(data));

export const classifyOneNow = createServerFn({
	method: "POST",
})
	.inputValidator(classifyOneInputSchema)
	.handler(async ({ data }) => classifyOneNowCommand(data));

export const getAccountsData = createServerFn({ method: "GET" }).handler(
	loadAccountsData,
);

export const getAccountNewData = createServerFn({ method: "GET" }).handler(
	loadAccountNewData,
);

export const getAccountDetailData = createServerFn({
	method: "GET",
})
	.inputValidator(accountIdInputSchema)
	.handler(async ({ data }) => loadAccountDetailData(data));

export const getAccountReconnectData = createServerFn({
	method: "GET",
})
	.inputValidator(accountIdInputSchema)
	.handler(async ({ data }) => loadAccountReconnectData(data));

export const getAccountDeleteData = createServerFn({
	method: "GET",
})
	.inputValidator(accountIdInputSchema)
	.handler(async ({ data }) => loadAccountDeleteData(data));

export const beginGoogleConnect = createServerFn({
	method: "POST",
})
	.inputValidator(beginGoogleConnectInputSchema)
	.handler(async ({ data }) => beginGoogleConnectCommand(data));

export const completeGoogleConnect = createServerFn({
	method: "POST",
})
	.inputValidator(completeGoogleConnectInputSchema)
	.handler(async ({ data }) => completeGoogleConnectCommand(data));

export const beginGoogleReconnect = createServerFn({
	method: "POST",
})
	.inputValidator(beginGoogleReconnectInputSchema)
	.handler(async ({ data }) => beginGoogleReconnectCommand(data));

export const queueAccountFullSync = createServerFn({
	method: "POST",
})
	.inputValidator(accountIdInputSchema)
	.handler(async ({ data }) => queueAccountFullSyncCommand(data));

export const queueAccountDeltaSync = createServerFn({
	method: "POST",
})
	.inputValidator(accountIdInputSchema)
	.handler(async ({ data }) => queueAccountDeltaSyncCommand(data));

export const queueAccountReconcile = createServerFn({
	method: "POST",
})
	.inputValidator(accountIdInputSchema)
	.handler(async ({ data }) => queueAccountReconcileCommand(data));

export const queueAccountClassifyBacklog = createServerFn({
	method: "POST",
})
	.inputValidator(accountIdInputSchema)
	.handler(async ({ data }) => queueAccountClassifyBacklogCommand(data));

export const queueAccountFinanceBacklog = createServerFn({
	method: "POST",
})
	.inputValidator(accountIdInputSchema)
	.handler(async ({ data }) => queueAccountFinanceBacklogCommand(data));

export const queueImportOperatorRegistry = createServerFn({
	method: "POST",
}).handler(queueImportOperatorRegistryCommand);

export const queueRebuildFinanceKnowledge = createServerFn({
	method: "POST",
}).handler(queueRebuildFinanceKnowledgeCommand);

export const queueRebuildFinanceRollups = createServerFn({
	method: "POST",
}).handler(queueRebuildFinanceRollupsCommand);

export const queueReconcileRegistrySuggestions = createServerFn({
	method: "POST",
}).handler(queueReconcileRegistrySuggestionsCommand);

export const queueImportFinanceArtifact = createServerFn({
	method: "POST",
})
	.inputValidator(financeArtifactImportInputSchema)
	.handler(async ({ data }) => queueImportFinanceArtifactCommand(data));

export const queueReclassifyRootBacklog = createServerFn({
	method: "POST",
})
	.inputValidator(accountIdInputSchema)
	.handler(async ({ data }) => queueReclassifyRootBacklogCommand(data));

export const queueReclassifyFinanceBacklog = createServerFn({
	method: "POST",
})
	.inputValidator(accountIdInputSchema)
	.handler(async ({ data }) => queueReclassifyFinanceBacklogCommand(data));

export const pauseAccountSync = createServerFn({
	method: "POST",
})
	.inputValidator(accountIdInputSchema)
	.handler(async ({ data }) => pauseAccountSyncCommand(data));

export const resumeAccountSync = createServerFn({
	method: "POST",
})
	.inputValidator(accountIdInputSchema)
	.handler(async ({ data }) => resumeAccountSyncCommand(data));

export const disconnectAccount = createServerFn({
	method: "POST",
})
	.inputValidator(accountIdInputSchema)
	.handler(async ({ data }) => disconnectAccountCommand(data));

export const purgeAccount = createServerFn({
	method: "POST",
})
	.inputValidator(purgeAccountInputSchema)
	.handler(async ({ data }) => purgeAccountCommand(data));
