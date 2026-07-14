import { UsersRound } from "lucide-react";
import type { ProjectMember, User } from "../types";

type TeamSelectorProps = {
  users: User[];
  ownerId: string;
  members: ProjectMember[];
  onMembersChange: (members: ProjectMember[]) => void;
};

export function TeamSelector({
  users,
  ownerId,
  members,
  onMembersChange,
}: TeamSelectorProps) {
  function toggleUser(userId: string) {
    if (userId === ownerId) {
      return;
    }

    const exists = members.some((member) => member.userId === userId);
    onMembersChange(
      exists
        ? members.filter((member) => member.userId !== userId)
        : [...members, { userId, role: "viewer", addedAt: new Date().toISOString(), addedBy: ownerId }],
    );
  }

  function updateRole(userId: string, role: ProjectMember["role"]) {
    onMembersChange(members.map((member) => (member.userId === userId ? { ...member, role } : member)));
  }

  return (
    <div className="space-y-4">
      <div>
        <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-stone-500">
          <UsersRound className="h-3.5 w-3.5" />
          Invited users
        </div>
        <div className="space-y-2">
          {users.map((user) => {
            const member = members.find((item) => item.userId === user.id);
            const checked = Boolean(member);
            const owner = user.id === ownerId;

            return (
              <div key={user.id} className="flex items-center gap-2 rounded-md border border-line px-2 py-2">
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={owner}
                  onChange={() => toggleUser(user.id)}
                  className="h-4 w-4 rounded border-line accent-accent"
                  aria-label={`Invite ${user.name}`}
                />
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-mist text-[11px] font-bold text-stone-600">
                  {user.avatar ?? user.name.slice(0, 2).toUpperCase()}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm font-semibold">
                  {user.name}
                  {owner ? <span className="ml-1 text-xs font-normal text-stone-500">(owner)</span> : null}
                </span>
                <select
                  value={member?.role ?? "viewer"}
                  disabled={!checked || owner}
                  onChange={(event) => updateRole(user.id, event.target.value as ProjectMember["role"])}
                  className="h-8 rounded-md border border-line bg-white px-2 text-xs outline-none disabled:opacity-50"
                >
                  <option value="owner">Owner</option>
                  <option value="editor">Editor</option>
                  <option value="viewer">Viewer</option>
                </select>
              </div>
            );
          })}
        </div>
      </div>

    </div>
  );
}
