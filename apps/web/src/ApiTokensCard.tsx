import { useState } from "react";
import { Bot, Check, Copy, KeyRound, Plus, Trash2 } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  API_TOKEN_TTL_DAYS,
  type ApiToken,
  type ApiTokenCreate,
  type ApiTokenCreated,
  type OAuthConnection,
} from "@quiz/contracts";

import { api } from "./api";
import { useConfirm } from "./confirm";
import { useI18n } from "./i18n";
import { apiTokensKey, connectionsKey } from "./queryKeys";
import {
  Actions,
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  FormDialog,
  FormError,
  isoDateTime,
  Modal,
  QueryError,
  SectionHeading,
  Select,
  Skeleton,
  T,
  cx,
  inputClass,
} from "./ui";

/** Where an MCP client connects: this origin, the API's MCP route. */
const mcpUrl = () => `${window.location.origin}/app/api/mcp`;

/** A read-only value with a copy button: the token, the MCP address, a command line. */
function CopyField({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // No clipboard (an insecure origin): the field stays selectable by hand.
    }
  };
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-fg-muted">{label}</p>
      <div className="flex gap-2">
        <input
          readOnly
          value={value}
          aria-label={label}
          onFocus={(e) => e.currentTarget.select()}
          className={cx(inputClass, "h-8.5 min-w-0 flex-1 px-2.5 text-[13px]", mono && "font-mono")}
        />
        <Button variant="secondary" onClick={copy} aria-label={`${t("tokens.copy")} — ${label}`}>
          {copied ? <Check /> : <Copy />}
          {copied ? t("tokens.copied") : t("tokens.copy")}
        </Button>
      </div>
    </div>
  );
}

function statusOf(token: ApiToken): "active" | "expired" | "revoked" {
  if (token.revokedAt) return "revoked";
  if (token.expiresAt && new Date(token.expiresAt).getTime() <= Date.now()) return "expired";
  return "active";
}

const STATUS_TONE = { active: "green", expired: "amber", revoked: "zinc" } as const;

/** Name and lifetime; on success the dialog turns into the one-time reveal. */
function NewTokenDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [ttl, setTtl] = useState<string>("90");
  const create = useMutation({
    mutationFn: (body: ApiTokenCreate) =>
      api<ApiTokenCreated>("/app/api/me/tokens", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: apiTokensKey }),
  });

  if (create.data) {
    const token = create.data.token;
    return (
      <Modal
        title={t("tokens.createdTitle")}
        onClose={onClose}
        footer={<Button onClick={onClose}>{t("common.done")}</Button>}
      >
        <div className="space-y-4">
          <Alert tone="warning" icon={KeyRound}>
            {t("tokens.createdOnce")}
          </Alert>
          <CopyField label={t("tokens.token")} value={token} />
          <CopyField label={t("tokens.mcpUrl")} value={mcpUrl()} />
          <CopyField
            label={t("tokens.claudeCode")}
            value={`claude mcp add --transport http quiz ${mcpUrl()} --header "Authorization: Bearer ${token}"`}
          />
          <p className="text-sm text-fg-muted">{t("tokens.otherClients")}</p>
        </div>
      </Modal>
    );
  }

  return (
    <FormDialog
      title={t("tokens.new")}
      onClose={onClose}
      onSubmit={() =>
        create.mutate({
          name: name.trim(),
          expiresInDays: ttl === "never" ? null : (Number(ttl) as ApiTokenCreate["expiresInDays"]),
        })
      }
      submitLabel={t("tokens.create")}
      submitting={create.isPending}
      canSubmit={name.trim() !== ""}
      error={<FormError error={create.error} />}
    >
      <Field
        label={t("tokens.name")}
        fullWidth
        autoFocus
        maxLength={100}
        placeholder={t("tokens.namePlaceholder")}
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <Select label={t("tokens.expires")} value={ttl} onChange={(e) => setTtl(e.target.value)}>
        {API_TOKEN_TTL_DAYS.map((days) => (
          <option key={days} value={String(days)}>
            {t("tokens.days", { n: days })}
          </option>
        ))}
        <option value="never">{t("tokens.never")}</option>
      </Select>
    </FormDialog>
  );
}

/**
 * The assistants the teacher let in through OAuth (ADR-023) — claude.ai,
 * ChatGPT, Claude Code — with the address to give them. Revoking one ends
 * its access at once, its current token included.
 */
export function ConnectionsCard() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const connections = useQuery({
    queryKey: connectionsKey,
    queryFn: () => api<OAuthConnection[]>("/app/api/me/connections"),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api<void>(`/app/api/me/connections/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: connectionsKey }),
  });

  let body;
  if (connections.isPending) {
    body = (
      <div className="space-y-3 p-5">
        <Skeleton className="h-4 w-2/3" />
      </div>
    );
  } else if (connections.isError) {
    body = (
      <div className="p-5">
        <QueryError
          title={t("connections.loadError")}
          error={connections.error}
          onRetry={() => void connections.refetch()}
          retrying={connections.isFetching}
        />
      </div>
    );
  } else if (connections.data.length === 0) {
    body = <p className="px-5 py-4 text-sm text-fg-muted">{t("connections.empty")}</p>;
  } else {
    body = (
      <div className={cx(T.container, "overflow-x-auto")}>
        <table className={T.table}>
          <thead className={T.head}>
            <tr>
              <th className={T.th}>{t("connections.assistant")}</th>
              <th className={cx(T.th, T.colHigh)}>{t("connections.since")}</th>
              <th className={cx(T.th, T.colMid)}>{t("tokens.lastUsed")}</th>
              <th className={T.th}>
                <span className="sr-only">{t("common.actions")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {connections.data.map((c) => (
              <tr key={c.id} className={cx(T.row, T.rowHover)}>
                <td className={T.td}>
                  <p className="font-semibold">{c.clientName}</p>
                  <p className="font-mono text-xs text-fg-faint">{c.redirectHost}</p>
                </td>
                <td className={cx(T.td, T.colHigh, "tabular-nums text-fg-muted")}>{isoDateTime(c.createdAt)}</td>
                <td className={cx(T.td, T.colMid, "tabular-nums text-fg-muted")}>
                  {c.lastUsedAt ? isoDateTime(c.lastUsedAt) : "—"}
                </td>
                <td className={cx(T.td, T.stickyEnd, "text-right")}>
                  <Actions
                    size="sm"
                    items={[
                      {
                        label: t("connections.revoke"),
                        icon: Trash2,
                        danger: true,
                        onSelect: async () => {
                          if (
                            await confirm({
                              title: t("connections.revokeConfirm", { name: c.clientName }),
                              message: t("connections.revokeHint"),
                              confirmLabel: t("connections.revoke"),
                              cancelLabel: t("common.cancel"),
                              danger: true,
                            })
                          ) {
                            revoke.mutate(c.id);
                          }
                        },
                      },
                    ]}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <section className="space-y-3">
      <SectionHeading icon={Bot} title={t("connections.title")} description={t("connections.description")} />
      <Card className="divide-y divide-line">
        <div className="p-5">
          <CopyField label={t("tokens.mcpUrl")} value={mcpUrl()} />
        </div>
        {body}
      </Card>
      <FormError error={revoke.error} />
    </section>
  );
}

/**
 * Personal API tokens (ADR-022): what a script or an AI assistant connected
 * over MCP signs in with. The secret is shown once, in the creation dialog,
 * with the lines that connect a client; the list only ever shows a prefix.
 */
export function ApiTokensCard() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [creating, setCreating] = useState(false);
  const tokens = useQuery({
    queryKey: apiTokensKey,
    queryFn: () => api<ApiToken[]>("/app/api/me/tokens"),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api<ApiToken>(`/app/api/me/tokens/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: apiTokensKey }),
  });
  const newButton = (
    <Button variant="secondary" size="sm" onClick={() => setCreating(true)}>
      <Plus /> {t("tokens.new")}
    </Button>
  );

  let body;
  if (tokens.isPending) {
    body = (
      <div className="space-y-3 p-5">
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    );
  } else if (tokens.isError) {
    body = (
      <div className="p-5">
        <QueryError
          title={t("tokens.loadError")}
          error={tokens.error}
          onRetry={() => void tokens.refetch()}
          retrying={tokens.isFetching}
        />
      </div>
    );
  } else if (tokens.data.length === 0) {
    body = (
      <EmptyState icon={KeyRound} title={t("tokens.empty")} action={newButton} className="py-10">
        {t("tokens.emptyHint")}
      </EmptyState>
    );
  } else {
    body = (
      <div className={cx(T.container, "overflow-x-auto")}>
        <table className={T.table}>
          <thead className={T.head}>
            <tr>
              <th className={T.th}>{t("tokens.name")}</th>
              <th className={cx(T.th, T.colHigh)}>{t("tokens.lastUsed")}</th>
              <th className={cx(T.th, T.colMid)}>{t("tokens.expires")}</th>
              <th className={T.th}>{t("tokens.status")}</th>
              <th className={T.th}>
                <span className="sr-only">{t("common.actions")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {tokens.data.map((token) => {
              const status = statusOf(token);
              return (
                <tr key={token.id} className={cx(T.row, T.rowHover)}>
                  <td className={T.td}>
                    <p className="font-semibold">{token.name}</p>
                    <p className="font-mono text-xs text-fg-faint">{token.prefix}…</p>
                  </td>
                  <td className={cx(T.td, T.colHigh, "tabular-nums text-fg-muted")}>
                    {token.lastUsedAt ? isoDateTime(token.lastUsedAt) : "—"}
                  </td>
                  <td className={cx(T.td, T.colMid, "tabular-nums text-fg-muted")}>
                    {token.expiresAt ? isoDateTime(token.expiresAt) : t("tokens.never")}
                  </td>
                  <td className={T.td}>
                    <Badge tone={STATUS_TONE[status]}>{t(`tokens.status.${status}`)}</Badge>
                  </td>
                  <td className={cx(T.td, T.stickyEnd, "text-right")}>
                    {status === "revoked" ? null : (
                      <Actions
                        size="sm"
                        items={[
                          {
                            label: t("tokens.revoke"),
                            icon: Trash2,
                            danger: true,
                            onSelect: async () => {
                              if (
                                await confirm({
                                  title: t("tokens.revokeConfirm", { name: token.name }),
                                  message: t("tokens.revokeHint"),
                                  confirmLabel: t("tokens.revoke"),
                                  cancelLabel: t("common.cancel"),
                                  danger: true,
                                })
                              ) {
                                revoke.mutate(token.id);
                              }
                            },
                          },
                        ]}
                      />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <section className="space-y-3">
      <SectionHeading
        icon={KeyRound}
        title={t("tokens.title")}
        description={t("tokens.description")}
        actions={tokens.data && tokens.data.length > 0 ? newButton : null}
      />
      <Card>{body}</Card>
      <FormError error={revoke.error} />
      {creating ? <NewTokenDialog onClose={() => setCreating(false)} /> : null}
    </section>
  );
}
