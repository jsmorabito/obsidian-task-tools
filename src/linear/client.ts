/**
 * LinearClient — thin GraphQL wrapper for the Linear API.
 *
 * Supports both Personal API key auth and OAuth Bearer token auth.
 * Each workspace gets its own instance so tokens are never mixed.
 */

import type { LinearIssueStub, LinearTeam } from "../types";

const LINEAR_API = "https://api.linear.app/graphql";

export class LinearClient {
	private workspaceId: string;
	private token: string; // API key or OAuth access token

	constructor(workspaceId: string, token: string) {
		this.workspaceId = workspaceId;
		this.token = token;
	}

	// ── Core request ────────────────────────────────────────────────────────

	private async query<T>(gql: string, variables?: Record<string, unknown>): Promise<T> {
		// eslint-disable-next-line no-restricted-globals
		const res = await fetch(LINEAR_API, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: this.token,
			},
			body: JSON.stringify({ query: gql, variables }),
		});

		if (!res.ok) {
			throw new Error(`Linear API HTTP ${res.status}: ${res.statusText}`);
		}

		const json = (await res.json()) as { data?: T; errors?: { message: string }[] };

		if (json.errors?.length) {
			throw new Error(`Linear API error: ${json.errors.map((e) => e.message).join(", ")}`);
		}

		if (!json.data) throw new Error("Linear API returned no data");
		return json.data;
	}

	// ── Viewer / workspace ──────────────────────────────────────────────────

	async getViewerName(): Promise<string> {
		const data = await this.query<{ viewer: { name: string } }>(`
			query { viewer { name } }
		`);
		return data.viewer.name;
	}

	async getOrganizationName(): Promise<string> {
		const data = await this.query<{ organization: { name: string } }>(`
			query { organization { name } }
		`);
		return data.organization.name;
	}

	// ── Teams ───────────────────────────────────────────────────────────────

	async getTeams(): Promise<LinearTeam[]> {
		const data = await this.query<{ teams: { nodes: { id: string; name: string; key: string }[] } }>(`
			query {
				teams(first: 50) {
					nodes { id name key }
				}
			}
		`);
		return data.teams.nodes;
	}

	// ── Issues ──────────────────────────────────────────────────────────────

	/**
	 * Fetch issues for one team, filtered by states and assignee.
	 * Returns up to `limit` issues ordered by updatedAt desc.
	 */
	async getIssues(opts: {
		teamId?: string;
		assignedToMe?: boolean;
		includeCompleted?: boolean;
		limit?: number;
		after?: string;
	} = {}): Promise<{ issues: LinearIssueStub[]; nextCursor: string | null }> {
		const limit = opts.limit ?? 50;

		// Build filter object for the GraphQL variable
		const filter: Record<string, unknown> = {};
		if (opts.teamId) filter["team"] = { id: { eq: opts.teamId } };
		if (opts.assignedToMe) filter["assignee"] = { isMe: { eq: true } };
		if (!opts.includeCompleted) {
			filter["state"] = { type: { nin: ["completed", "cancelled"] } };
		}

		const data = await this.query<{
			issues: {
				nodes: {
					id: string;
					identifier: string;
					title: string;
					url: string;
					priority: number;
					state: { name: string; type: string };
					team: { id: string; name: string };
				}[];
				pageInfo: { hasNextPage: boolean; endCursor: string };
			};
		}>(
			`
			query GetIssues($filter: IssueFilter, $first: Int, $after: String) {
				issues(filter: $filter, first: $first, after: $after, orderBy: updatedAt) {
					nodes {
						id identifier title url priority
						state { name type }
						team { id name }
					}
					pageInfo { hasNextPage endCursor }
				}
			}
		`,
			{ filter, first: limit, after: opts.after ?? null }
		);

		const issues: LinearIssueStub[] = data.issues.nodes.map((n) => ({
			id: n.id,
			identifier: n.identifier,
			title: n.title,
			url: n.url,
			priority: n.priority,
			stateName: n.state.name,
			stateType: n.state.type,
			teamId: n.team.id,
			teamName: n.team.name,
			workspaceId: this.workspaceId,
		}));

		const nextCursor = data.issues.pageInfo.hasNextPage
			? data.issues.pageInfo.endCursor
			: null;

		return { issues, nextCursor };
	}

	/** Fetch a single issue by its Linear UUID. */
	async getIssue(id: string): Promise<LinearIssueStub | null> {
		try {
			const data = await this.query<{
				issue: {
					id: string;
					identifier: string;
					title: string;
					url: string;
					priority: number;
					state: { name: string; type: string };
					team: { id: string; name: string };
				};
			}>(
				`
				query GetIssue($id: String!) {
					issue(id: $id) {
						id identifier title url priority
						state { name type }
						team { id name }
					}
				}
			`,
				{ id }
			);
			const n = data.issue;
			return {
				id: n.id,
				identifier: n.identifier,
				title: n.title,
				url: n.url,
				priority: n.priority,
				stateName: n.state.name,
				stateType: n.state.type,
				teamId: n.team.id,
				teamName: n.team.name,
				workspaceId: this.workspaceId,
			};
		} catch {
			return null;
		}
	}

	// ── Mutations ───────────────────────────────────────────────────────────

	/**
	 * Update the state of a Linear issue.
	 * `stateId` is the Linear UUID of the target WorkflowState.
	 */
	async updateIssueState(issueId: string, stateId: string): Promise<void> {
		await this.query<unknown>(
			`
			mutation UpdateIssue($id: String!, $stateId: String!) {
				issueUpdate(id: $id, input: { stateId: $stateId }) {
					success
				}
			}
		`,
			{ id: issueId, stateId }
		);
	}

	/**
	 * Create a new issue and return its stub.
	 */
	async createIssue(opts: {
		teamId: string;
		title: string;
		description?: string;
		priority?: number;
	}): Promise<LinearIssueStub> {
		const data = await this.query<{
			issueCreate: {
				issue: {
					id: string;
					identifier: string;
					title: string;
					url: string;
					priority: number;
					state: { name: string; type: string };
					team: { id: string; name: string };
				};
			};
		}>(
			`
			mutation CreateIssue($input: IssueCreateInput!) {
				issueCreate(input: $input) {
					issue {
						id identifier title url priority
						state { name type }
						team { id name }
					}
				}
			}
		`,
			{
				input: {
					teamId: opts.teamId,
					title: opts.title,
					description: opts.description,
					priority: opts.priority,
				},
			}
		);
		const n = data.issueCreate.issue;
		return {
			id: n.id,
			identifier: n.identifier,
			title: n.title,
			url: n.url,
			priority: n.priority,
			stateName: n.state.name,
			stateType: n.state.type,
			teamId: n.team.id,
			teamName: n.team.name,
			workspaceId: this.workspaceId,
		};
	}

	/**
	 * Fetch all workflow states for a team, needed to translate status names → IDs.
	 */
	async getWorkflowStates(teamId: string): Promise<{ id: string; name: string; type: string }[]> {
		const data = await this.query<{
			workflowStates: {
				nodes: { id: string; name: string; type: string }[];
			};
		}>(
			`
			query GetStates($filter: WorkflowStateFilter) {
				workflowStates(filter: $filter, first: 100) {
					nodes { id name type }
				}
			}
		`,
			{ filter: { team: { id: { eq: teamId } } } }
		);
		return data.workflowStates.nodes;
	}
}

// ── OAuth helpers ────────────────────────────────────────────────────────────

export const LINEAR_OAUTH_AUTHORIZE_URL = "https://linear.app/oauth/authorize";
export const LINEAR_OAUTH_TOKEN_URL = "https://api.linear.app/oauth/token";

/**
 * Build the URL the user visits to start the OAuth flow.
 * `redirectUri` must exactly match what you registered in the Linear app settings.
 */
export function buildOAuthUrl(opts: {
	clientId: string;
	redirectUri: string;
	state: string;
	scopes?: string[];
}): string {
	const scopes = opts.scopes ?? ["read", "write", "issues:create"];
	const params = new URLSearchParams({
		client_id: opts.clientId,
		redirect_uri: opts.redirectUri,
		response_type: "code",
		scope: scopes.join(","),
		state: opts.state,
		actor: "user",
	});
	return `${LINEAR_OAUTH_AUTHORIZE_URL}?${params.toString()}`;
}

/**
 * Exchange an authorization code for an access token.
 * Should be called server-side or via a proxy — not directly in the plugin
 * unless the client secret is acceptable in the desktop context.
 */
export async function exchangeOAuthCode(opts: {
	code: string;
	clientId: string;
	clientSecret: string;
	redirectUri: string;
}): Promise<{ accessToken: string; tokenType: string; scope: string }> {
	// eslint-disable-next-line no-restricted-globals
	const res = await fetch(LINEAR_OAUTH_TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			code: opts.code,
			client_id: opts.clientId,
			client_secret: opts.clientSecret,
			redirect_uri: opts.redirectUri,
			grant_type: "authorization_code",
		}).toString(),
	});
	if (!res.ok) throw new Error(`OAuth token exchange failed: ${res.status}`);
	const json = (await res.json()) as { access_token: string; token_type: string; scope: string };
	return { accessToken: json.access_token, tokenType: json.token_type, scope: json.scope };
}
