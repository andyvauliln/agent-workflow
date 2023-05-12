/* eslint-disable @typescript-eslint/no-non-null-assertion */
/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
/* eslint-disable @typescript-eslint/naming-convention */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/restrict-template-expressions */
import {
	ErrorReporterProxy as ErrorReporter,
	LoggerProxy as Logger,
	WorkflowOperationError,
} from 'n8n-workflow';
import { Service } from 'typedi';
import type { FindManyOptions, ObjectLiteral } from 'typeorm';
import { Not, LessThanOrEqual } from 'typeorm';
import { DateUtils } from 'typeorm/util/DateUtils';

import config from '@/config';
import * as Db from '@/Db';
import * as ResponseHelper from '@/ResponseHelper';
import type {
	IExecutionFlattedDb,
	IExecutionsStopData,
	IWorkflowExecutionDataProcess,
} from '@/Interfaces';
import { WorkflowRunner } from '@/WorkflowRunner';
import { getWorkflowOwner } from '@/UserManagement/UserManagementHelper';
import { ExecutionRepository } from './databases/repositories';
import type { ExecutionEntity } from './databases/entities/ExecutionEntity';

@Service()
export class WaitTracker {
	private waitingExecutions: {
		[key: string]: {
			executionId: string;
			timer: NodeJS.Timeout;
		};
	} = {};

	mainTimer: NodeJS.Timeout;

	constructor(private executionRepository: ExecutionRepository) {
		// Poll every 60 seconds a list of upcoming executions
		this.mainTimer = setInterval(() => {
			void this.getWaitingExecutions();
		}, 60000);

		void this.getWaitingExecutions();
	}

	// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
	async getWaitingExecutions() {
		Logger.debug('Wait tracker querying database for waiting executions');
		// Find all the executions which should be triggered in the next 70 seconds
		const findQuery: FindManyOptions<ExecutionEntity> = {
			select: ['id', 'waitTill'],
			where: {
				waitTill: LessThanOrEqual(new Date(Date.now() + 70000)),
				status: Not('crashed'),
			},
			order: {
				waitTill: 'ASC',
			},
		};

		const dbType = config.getEnv('database.type');
		if (dbType === 'sqlite') {
			// This is needed because of issue in TypeORM <> SQLite:
			// https://github.com/typeorm/typeorm/issues/2286
			(findQuery.where! as ObjectLiteral).waitTill = LessThanOrEqual(
				DateUtils.mixedDateToUtcDatetimeString(new Date(Date.now() + 70000)),
			);
		}

		const executions = await this.executionRepository.findMultipleExecutions(findQuery);

		if (executions.length === 0) {
			return;
		}

		const executionIds = executions.map((execution) => execution.id).join(', ');
		Logger.debug(
			`Wait tracker found ${executions.length} executions. Setting timer for IDs: ${executionIds}`,
		);

		// Add timers for each waiting execution that they get started at the correct time
		// eslint-disable-next-line no-restricted-syntax
		for (const execution of executions) {
			const executionId = execution.id;
			if (this.waitingExecutions[executionId] === undefined) {
				const triggerTime = execution.waitTill!.getTime() - new Date().getTime();
				this.waitingExecutions[executionId] = {
					executionId,
					timer: setTimeout(() => {
						this.startExecution(executionId);
					}, triggerTime),
				};
			}
		}
	}

	async stopExecution(executionId: string): Promise<IExecutionsStopData> {
		if (this.waitingExecutions[executionId] !== undefined) {
			// The waiting execution was already scheduled to execute.
			// So stop timer and remove.
			clearTimeout(this.waitingExecutions[executionId].timer);
			delete this.waitingExecutions[executionId];
		}

		// Also check in database
		const execution = await this.executionRepository.findSingleExecution(executionId, {
			includeData: true,
			includeWorkflowData: true,
			unflattenData: true,
		});

		if (!execution?.waitTill) {
			throw new Error(`The execution ID "${executionId}" could not be found.`);
		}

		// Set in execution in DB as failed and remove waitTill time
		const error = new WorkflowOperationError('Workflow-Execution has been canceled!');

		execution.data.resultData.error = {
			...error,
			message: error.message,
			stack: error.stack,
		};

		execution.stoppedAt = new Date();
		execution.waitTill = null;
		execution.status = 'canceled';

		await Db.collections.Execution.update(
			executionId,
			ResponseHelper.flattenExecutionData({
				...execution,
			}) as IExecutionFlattedDb,
		);

		return {
			mode: execution.mode,
			startedAt: new Date(execution.startedAt),
			stoppedAt: execution.stoppedAt ? new Date(execution.stoppedAt) : undefined,
			finished: execution.finished,
			status: execution.status,
		};
	}

	startExecution(executionId: string) {
		Logger.debug(`Wait tracker resuming execution ${executionId}`, { executionId });
		delete this.waitingExecutions[executionId];

		(async () => {
			// Get the data to execute
			const fullExecutionData = await this.executionRepository.findSingleExecution(executionId, {
				includeData: true,
				includeWorkflowData: true,
				unflattenData: true,
			});

			if (!fullExecutionData) {
				throw new Error(`The execution with the id "${executionId}" does not exist.`);
			}
			if (fullExecutionData.finished) {
				throw new Error('The execution did succeed and can so not be started again.');
			}

			if (!fullExecutionData.workflowData.id) {
				throw new Error('Only saved workflows can be resumed.');
			}
			const user = await getWorkflowOwner(fullExecutionData.workflowData.id);

			const data: IWorkflowExecutionDataProcess = {
				executionMode: fullExecutionData.mode,
				executionData: fullExecutionData.data,
				workflowData: fullExecutionData.workflowData,
				userId: user.id,
			};

			// Start the execution again
			const workflowRunner = new WorkflowRunner();
			await workflowRunner.run(data, false, false, executionId);
		})().catch((error: Error) => {
			ErrorReporter.error(error);
			Logger.error(
				`There was a problem starting the waiting execution with id "${executionId}": "${error.message}"`,
				{ executionId },
			);
		});
	}
}
