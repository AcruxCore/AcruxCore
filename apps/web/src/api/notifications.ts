import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import { keys } from './queryClient';
import type {
  NotificationPreferencesResponse,
  UpdateNotificationPreferenceInput,
} from './types';

/**
 * The signed-in user's notification preferences for their active team.
 *
 * Preferences are per team, so this is refetched whenever the active team changes
 * — the query key is team-agnostic but the API scopes to `req.teamId`, and the
 * team switcher invalidates the whole cache.
 */
export function useNotificationPreferences() {
  return useQuery({
    queryKey: keys.notificationPreferences,
    queryFn: () => api<NotificationPreferencesResponse>('/notifications/preferences'),
  });
}

/**
 * Toggles one category, optimistically.
 *
 * The optimistic write matters more than usual here: a switch that visibly waits
 * for a round-trip reads as broken. `onMutate` snapshots the previous map and
 * `onError` restores it, so a failed PATCH snaps the switch back rather than
 * leaving the UI claiming a preference the server never stored.
 */
export function useUpdateNotificationPreference() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateNotificationPreferenceInput) =>
      api<NotificationPreferencesResponse>('/notifications/preferences', {
        method: 'PATCH',
        body,
      }),
    onMutate: async (body) => {
      await qc.cancelQueries({ queryKey: keys.notificationPreferences });
      const previous = qc.getQueryData<NotificationPreferencesResponse>(
        keys.notificationPreferences,
      );
      if (previous) {
        qc.setQueryData<NotificationPreferencesResponse>(keys.notificationPreferences, {
          preferences: { ...previous.preferences, [body.category]: body.enabled },
        });
      }
      return { previous };
    },
    onError: (_err, _body, context) => {
      if (context?.previous) {
        qc.setQueryData(keys.notificationPreferences, context.previous);
      }
    },
    // The response carries the full effective map, so the server's answer replaces
    // the optimistic guess without a second GET.
    onSuccess: (data) => qc.setQueryData(keys.notificationPreferences, data),
  });
}
