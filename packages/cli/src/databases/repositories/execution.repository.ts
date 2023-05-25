import { Service } from 'typedi';
import {
	DataSource,
	In,
	LessThanOrEqual,
	MoreThanOrEqual,
	Repository,
	SelectQueryBuilder,
} from 'typeorm';
import type { FindManyOptions, FindOneOptions, FindOptionsWhere } from 'typeorm';
import { ExecutionEntity } from '../entities/ExecutionEntity';
import { parse, stringify } from 'flatted';
import type {
	IExecutionDb,
	IExecutionFlattedDb,
	IExecutionResponse,
	IWorkflowDb,
} from '@/Interfaces';
import { IExecutionsSummary, IRunExecutionData, IWorkflowBase, LoggerProxy } from 'n8n-workflow';
import { ExecutionDataRepository } from './executionData.repository';
import { ExecutionData } from '../entities/ExecutionData';
import type { IGetExecutionsQueryFilter } from '@/executions/executions.service';
import { isAdvancedExecutionFiltersEnabled } from '@/executions/executionHelpers';
import { ExecutionMetadata } from '../entities/ExecutionMetadata';
import { DateUtils } from 'typeorm/util/DateUtils';
import { BinaryDataManager } from 'n8n-core';

function parseFiltersToQueryBuilder(
	qb: SelectQueryBuilder<ExecutionEntity>,
	filters: IGetExecutionsQueryFilter | undefined,
) {
	if (filters?.status) {
		qb.andWhere('execution.status IN (:...workflowStatus)', {
			workflowStatus: filters.status,
		});
	}
	if (filters?.finished) {
		qb.andWhere({ finished: filters.finished });
	}
	if (filters?.metadata && isAdvancedExecutionFiltersEnabled()) {
		qb.leftJoin(ExecutionMetadata, 'md', 'md.executionId = execution.id');
		for (const md of filters.metadata) {
			qb.andWhere('md.key = :key AND md.value = :value', md);
		}
	}
	if (filters?.startedAfter) {
		qb.andWhere({
			startedAt: MoreThanOrEqual(
				DateUtils.mixedDateToUtcDatetimeString(new Date(filters.startedAfter)),
			),
		});
	}
	if (filters?.startedBefore) {
		qb.andWhere({
			startedAt: LessThanOrEqual(
				DateUtils.mixedDateToUtcDatetimeString(new Date(filters.startedBefore)),
			),
		});
	}
	if (filters?.workflowId) {
		qb.andWhere({
			workflowId: filters.workflowId,
		});
	}
}

@Service()
export class ExecutionRepository extends Repository<ExecutionEntity> {
	private executionDataRepository: ExecutionDataRepository;

	constructor(dataSource: DataSource, executionDataRepository: ExecutionDataRepository) {
		super(ExecutionEntity, dataSource.manager);
		this.executionDataRepository = executionDataRepository;
	}

	async findMultipleExecutions(
		queryParams: FindManyOptions<ExecutionEntity>,
		options?: {
			unflattenData: true;
			includeWorkflowData?: boolean;
			includeData?: boolean;
		},
	): Promise<IExecutionResponse[]>;
	async findMultipleExecutions(
		queryParams: FindManyOptions<ExecutionEntity>,
		options?: {
			unflattenData?: false;
			includeWorkflowData?: boolean;
			includeData?: boolean;
		},
	): Promise<IExecutionFlattedDb[]>;
	async findMultipleExecutions(
		queryParams: FindManyOptions<ExecutionEntity>,
		options?: {
			unflattenData?: boolean;
			includeWorkflowData?: boolean;
			includeData?: boolean;
		},
	) {
		if (options?.includeData || options?.includeWorkflowData) {
			if (!queryParams.relations) {
				queryParams.relations = [];
			}
			(queryParams.relations as string[]).push('executionData');
		}

		const executions = await this.find(queryParams);

		if (options?.includeData && options?.unflattenData) {
			return executions.map((execution) => {
				const { executionData, ...rest } = execution;
				return {
					...rest,
					data: parse(execution.executionData.data) as IRunExecutionData,
					workflowData: execution.executionData.workflowData,
				} as IExecutionResponse;
			});
		}

		return executions.map((execution) => {
			const { executionData, ...rest } = execution;
			return {
				...rest,
				data: execution.executionData.data,
				workflowData: execution.executionData.workflowData,
			} as IExecutionFlattedDb;
		});
	}

	async findSingleExecution(
		id: string,
		options?: {
			includeData?: boolean;
			includeWorkflowData?: boolean;
			unflattenData?: true;
			where?: FindOptionsWhere<ExecutionEntity>;
		},
	): Promise<IExecutionResponse | undefined>;
	async findSingleExecution(
		id: string,
		options?: {
			includeData?: boolean;
			includeWorkflowData?: boolean;
			unflattenData?: false;
			where?: FindOptionsWhere<ExecutionEntity>;
		},
	): Promise<IExecutionFlattedDb | undefined>;
	async findSingleExecution(
		id: string,
		options?: {
			includeData?: boolean;
			includeWorkflowData?: boolean;
			unflattenData?: boolean;
			where?: FindOptionsWhere<ExecutionEntity>;
		},
	): Promise<IExecutionFlattedDb | IExecutionResponse | undefined> {
		const whereClause: FindOneOptions<ExecutionEntity> = {
			where: {
				id,
				...options?.where,
			},
		};
		if (options?.includeData || options?.includeWorkflowData) {
			whereClause.relations = ['executionData'];
		}

		const execution = await this.findOne(whereClause);

		if (!execution) {
			return undefined;
		}

		const { executionData, ...rest } = execution;

		if (options?.includeData && options?.unflattenData) {
			return {
				...rest,
				data: parse(execution.executionData.data) as IRunExecutionData,
				workflowData: execution.executionData.workflowData,
			} as IExecutionResponse;
		}

		return {
			...rest,
			data: execution.executionData.data,
			workflowData: execution.executionData.workflowData,
		} as IExecutionFlattedDb;
	}

	async createNewExecution(execution: IExecutionDb) {
		const { data, workflowData, ...rest } = execution;

		const newExecution = await this.save({
			...rest,
		});
		await this.executionDataRepository.save({
			execution: newExecution,
			workflowData,
			data: stringify(data),
		});

		return newExecution;
	}

	async updateExistingExecution(executionId: string, execution: Partial<IExecutionResponse>) {
		const { id, data, workflowData, ...executionInformation } = execution;

		await this.manager.transaction(async (transactionManager) => {
			if (Object.keys(executionInformation).length > 0) {
				await transactionManager.update(ExecutionEntity, { id: executionId }, executionInformation);
			}

			if (data || workflowData) {
				const executionData = {} as Partial<ExecutionData>;
				if (workflowData) {
					executionData.workflowData = workflowData;
				}
				if (data) {
					executionData.data = stringify(data);
				}
				// TODO: understand why ts is complaining here
				// @ts-ignore
				await transactionManager.update(ExecutionData, { executionId }, executionData);
			}
		});
	}

	async deleteExecution(executionId: string) {
		// TODO: Should this be awaited? Should we add a catch in case it fails?
		await BinaryDataManager.getInstance().deleteBinaryDataByExecutionId(executionId);
		return this.delete({ id: executionId });
	}

	async searchExecutions(
		filters: IGetExecutionsQueryFilter | undefined,
		limit: number,
		excludedExecutionIds: string[],
		accessibleWorkflowIds: string[],
		additionalFilters?: { lastId?: string; firstId?: string },
	): Promise<IExecutionsSummary[]> {
		if (accessibleWorkflowIds.length === 0) {
			return [];
		}
		const query = this.createQueryBuilder('execution')
			.select([
				'execution.id',
				'execution.finished',
				'execution.mode',
				'execution.retryOf',
				'execution.retrySuccessId',
				'execution.status',
				'execution.startedAt',
				'execution.stoppedAt',
				'execution.workflowId',
				'execution.waitTill',
				'workflow.name',
			])
			.innerJoin('execution.workflow', 'workflow')
			.limit(limit)
			.orderBy('execution.startedAt', 'DESC')
			.andWhere('execution.workflowId IN (:...accessibleWorkflowIds)', { accessibleWorkflowIds });

		if (excludedExecutionIds.length > 0) {
			query.andWhere('execution.id NOT IN (:...excludedExecutionIds)', { excludedExecutionIds });
		}

		if (additionalFilters?.lastId) {
			query.andWhere('execution.id < :lastId', { lastId: additionalFilters.lastId });
		}
		if (additionalFilters?.firstId) {
			query.andWhere('execution.id > :firstId', { firstId: additionalFilters.firstId });
		}

		parseFiltersToQueryBuilder(query, filters);

		const executions = await query.getMany();

		return executions.map((execution) => {
			const { workflow, waitTill, ...rest } = execution;
			return {
				...rest,
				waitTill: waitTill ?? undefined,
				workflowName: workflow.name,
			};
		});
	}

	async deleteExecutions(
		filters: IGetExecutionsQueryFilter | undefined,
		accessibleWorkflowIds: string[],
		deleteConditions: {
			deleteBefore?: Date;
			ids?: string[];
		},
	) {
		if (!deleteConditions?.deleteBefore && !deleteConditions?.ids) {
			throw new Error('Either "deleteBefore" or "ids" must be present in the request body');
		}

		const query = this.createQueryBuilder('execution')
			.select(['execution.id'])
			.andWhere('execution.workflowId IN (:...accessibleWorkflowIds)', { accessibleWorkflowIds });

		if (deleteConditions.deleteBefore) {
			// delete executions by date, if user may access the underlying workflows
			query.andWhere('execution.startedAt', LessThanOrEqual(deleteConditions.deleteBefore));
			// Filters are only used when filtering by date
			parseFiltersToQueryBuilder(query, filters);
		} else if (deleteConditions.ids) {
			// delete executions by IDs, if user may access the underlying workflows
			query.andWhere('execution.id IN (:...executionIds)', { executionIds: deleteConditions.ids });
		}

		const executions = await query.getMany();

		// if (!executions.length) {
		// 	if (deleteConditions.ids) {
		// 		LoggerProxy.error('Failed to delete an execution due to insufficient permissions', {
		// 			executionIds: deleteConditions.ids,
		// 		});
		// 	}
		// 	return;
		// }

		// // const idsToDelete = executions.map(({ id }) => id);

		// // const binaryDataManager = BinaryDataManager.getInstance();
		// // await Promise.all(
		// // 	idsToDelete.map(async (id) => binaryDataManager.deleteBinaryDataByExecutionId(id)),
		// // );

		// // do {
		// // 	// Delete in batches to avoid "SQLITE_ERROR: Expression tree is too large (maximum depth 1000)" error
		// // 	const batch = idsToDelete.splice(0, 500);
		// // 	await this.delete(batch);
		// // } while (idsToDelete.length > 0);
	}
}
