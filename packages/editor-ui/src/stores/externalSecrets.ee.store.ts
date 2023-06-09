import { computed, reactive } from 'vue';
import { defineStore } from 'pinia';
import { EnterpriseEditionFeature } from '@/constants';
import { useRootStore } from '@/stores/n8nRoot.store';
import { useSettingsStore } from '@/stores/settings.store';
import * as externalSecretsApi from '@/api/externalSecrets.ee';
import type { ExternalSecretsProvider } from '@/Interface';
import { getExternalSecrets } from '@/api/externalSecrets.ee';

export const useExternalSecretsStore = defineStore('externalSecrets', () => {
	const rootStore = useRootStore();
	const settingsStore = useSettingsStore();

	const state = reactive({
		providers: [] as ExternalSecretsProvider[],
		secrets: {} as Record<string, string[]>,
	});

	const isEnterpriseExternalSecretsEnabled = computed(
		() =>
			settingsStore.isEnterpriseFeatureEnabled(EnterpriseEditionFeature.ExternalSecrets) || true,
	);

	const secrets = computed(() => state.secrets);
	const providers = computed(() => state.providers);

	const secretsAsObject = computed(() => {
		return Object.keys(secrets.value).reduce<Record<string, Record<string, string>>>(
			(providerAcc, provider) => {
				providerAcc[provider] = secrets.value[provider]?.reduce<Record<string, string>>(
					(secretAcc, secret) => {
						secretAcc[secret] = '*********';
						return secretAcc;
					},
					{},
				);

				return providerAcc;
			},
			{},
		);
	});

	async function fetchAllSecrets() {
		state.secrets = await externalSecretsApi.getExternalSecrets(rootStore.getRestApiContext);
	}

	async function getProviders() {
		state.providers = await externalSecretsApi.getExternalSecretsProviders(
			rootStore.getRestApiContext,
		);
	}

	async function getProvider(id: string) {
		const provider = await externalSecretsApi.getExternalSecretsProvider(
			rootStore.getRestApiContext,
			id,
		);

		const existingProviderIndex = state.providers.findIndex((p) => p.id === id);
		if (existingProviderIndex !== -1) {
			state.providers.splice(existingProviderIndex, 1, provider);
		} else {
			state.providers.push(provider);
		}

		return provider;
	}

	async function updateProviderConnected(id: string, value: boolean) {
		await updateProvider(id, { connected: value });
		await getExternalSecrets(rootStore.getRestApiContext);
	}

	async function updateProvider(id: string, data: Partial<ExternalSecretsProvider>) {
		const providerIndex = state.providers.findIndex((p) => p.id === id);
		state.providers = [
			...state.providers.slice(0, providerIndex),
			{
				...state.providers[providerIndex],
				...data,
			},
			...state.providers.slice(providerIndex + 1),
		];

		await externalSecretsApi.updateProvider(rootStore.getRestApiContext, id, data);
	}

	return {
		providers,
		secrets,
		secretsAsObject,
		isEnterpriseExternalSecretsEnabled,
		fetchAllSecrets,
		getProvider,
		getProviders,
		updateProvider,
		updateProviderConnected,
	};
});
