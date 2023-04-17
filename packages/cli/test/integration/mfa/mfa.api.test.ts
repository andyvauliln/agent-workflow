import express from 'express';
import config from '@/config';
import * as Db from '@/Db';
import type { Role } from '@db/entities/Role';
import type { User } from '@db/entities/User';
import * as testDb from './../shared/testDb';
import type { AuthAgent } from '../shared/types';
import * as utils from '../shared/utils';
import { randomPassword } from '@/Ldap/helpers';
import { randomDigit, randomValidPassword, uniqueId } from '../shared/random';
import { TOTPService } from '@/Mfa/totp.service';

jest.mock('@/telemetry');

let app: express.Application;
let globalOwnerRole: Role;
let owner: User;
let authAgent: AuthAgent;

beforeAll(async () => {
	app = await utils.initTestServer({ endpointGroups: ['mfa', 'auth', 'me', 'passwordReset'] });

	authAgent = utils.createAuthAgent(app);
});

beforeEach(async () => {
	await testDb.truncate(['User']);

	owner = await testDb.createUser({ globalRole: globalOwnerRole });

	config.set('userManagement.disabled', false);
});

afterAll(async () => {
	await testDb.terminate();
});

describe('Enable MFA setup', () => {
	describe('Step one', () => {
		test('GET /qr should fail due to unauthenticated user', async () => {
			const authlessAgent = utils.createAgent(app);

			const response = await authlessAgent.get('/mfa/qr');

			expect(response.statusCode).toBe(401);
		});

		test('GET /qr should reuse secret and recovery codes until setup is complete', async () => {
			const firstCall = await authAgent(owner).get('/mfa/qr');

			const secondCall = await authAgent(owner).get('/mfa/qr');

			expect(firstCall.body.data.secret).toBe(secondCall.body.data.secret);
			expect(firstCall.body.data.recoveryCodes.join('')).toBe(
				secondCall.body.data.recoveryCodes.join(''),
			);

			await authAgent(owner).delete('/mfa/disable');

			const thirdCall = await authAgent(owner).get('/mfa/qr');

			expect(firstCall.body.data.secret).not.toBe(thirdCall.body.data.secret);
			expect(firstCall.body.data.recoveryCodes.join('')).not.toBe(
				thirdCall.body.data.recoveryCodes.join(''),
			);
		});

		test('GET /qr should return qr, secret and recocery codes', async () => {
			const response = await authAgent(owner).get('/mfa/qr');

			expect(response.statusCode).toBe(200);

			const { data } = response.body;

			expect(data.secret).toBeDefined();
			expect(data.qrCode).toBeDefined();
			expect(data.recoveryCodes).toBeDefined();
			expect(data.recoveryCodes).not.toBeEmptyArray();
			expect(data.recoveryCodes.length).toBe(10);
		});
	});

	describe('Step two', () => {
		test('POST /verify should fail due to unauthenticated user', async () => {
			const authlessAgent = utils.createAgent(app);

			const response = await authlessAgent.post('/mfa/verify');

			expect(response.statusCode).toBe(401);
		});

		test('POST /verify should fail due to missing token parameter', async () => {
			const response = await authAgent(owner).post('/mfa/verify').send({ token: '123' });

			expect(response.statusCode).toBe(400);
		});

		test('POST /verify should fail due to invalid MFA token', async () => {
			await authAgent(owner).get('/mfa/qr');

			const response = await authAgent(owner).post('/mfa/verify').send({ token: '' });

			expect(response.statusCode).toBe(400);
		});

		test('POST /verify should validate MFA token', async () => {
			const response = await authAgent(owner).get('/mfa/qr');

			const { secret } = response.body.data;

			const token = new TOTPService().generateTOTP(secret);

			const { statusCode } = await authAgent(owner).post('/mfa/verify').send({ token });

			expect(statusCode).toBe(200);
		});
	});

	describe('Step three', () => {
		test('POST /enable should fail due to unauthenticated user', async () => {
			const authlessAgent = utils.createAgent(app);

			const response = await authlessAgent.post('/mfa/enable');

			expect(response.statusCode).toBe(401);
		});

		test('POST /verify should fail due to missing token parameter', async () => {
			const response = await authAgent(owner).post('/mfa/verify').send({ token: '123' });

			expect(response.statusCode).toBe(400);
		});

		test('POST /enable should fail due to invalid MFA token', async () => {
			await authAgent(owner).get('/mfa/qr');

			const response = await authAgent(owner).post('/mfa/enable').send({ token: '' });

			expect(response.statusCode).toBe(400);
		});

		test('POST /enable should fail due to empty secret and recovery codes', async () => {
			const response = await authAgent(owner).post('/mfa/enable');

			expect(response.statusCode).toBe(400);
		});

		test('POST /enable should enable MFA in account', async () => {
			const response = await authAgent(owner).get('/mfa/qr');

			const { secret } = response.body.data;

			const token = new TOTPService().generateTOTP(secret);

			await authAgent(owner).post('/mfa/verify').send({ token });

			const { statusCode } = await authAgent(owner).post('/mfa/enable').send({ token });

			expect(statusCode).toBe(200);

			const user = await Db.collections.User.findOneOrFail({
				where: {},
				select: ['mfaEnabled', 'mfaRecoveryCodes', 'mfaSecret'],
			});

			expect(user.mfaEnabled).toBe(true);
			expect(user.mfaRecoveryCodes).toBeDefined();
			expect(user.mfaSecret).toBeDefined();
		});
	});
});

describe('Disable MFA setup', () => {
	test('POST /disable should disable login with MFA', async () => {
		const { user } = await testDb.createUserWithMfaEnabled();

		const authAgent = utils.createAuthAgent(app);

		const response = await authAgent(user).delete('/mfa/disable');

		expect(response.statusCode).toBe(200);

		const dbUser = await Db.collections.User.findOneOrFail({
			where: { id: user.id },
			select: ['mfaEnabled', 'mfaRecoveryCodes', 'mfaSecret'],
		});

		expect(dbUser.mfaEnabled).toBe(false);
		expect(dbUser.mfaSecret).toBe(null);
		expect(dbUser.mfaRecoveryCodes.length).toBe(0);
	});
});

describe('Change password with MFA enabled', () => {
	test('PATCH /me/password should fail due to missing MFA token', async () => {
		const { user, rawPassword } = await testDb.createUserWithMfaEnabled();

		const newPassword = randomPassword();

		const authAgent = utils.createAuthAgent(app);

		const response = await authAgent(user)
			.patch('/me/password')
			.send({ currentPassword: rawPassword, newPassword });

		expect(response.statusCode).toBe(400);
	});

	test('PATCH /me/password should fail due to invalid MFA token', async () => {
		const { user, rawPassword } = await testDb.createUserWithMfaEnabled();

		const newPassword = randomValidPassword();

		const authAgent = utils.createAuthAgent(app);

		const response = await authAgent(user)
			.patch('/me/password')
			.send({ currentPassword: rawPassword, newPassword, mfaToken: randomDigit() });

		expect(response.statusCode).toBe(400);
	});

	test('PATCH /me/password should update password', async () => {
		const { user, rawPassword, rawSecret } = await testDb.createUserWithMfaEnabled();

		const token = new TOTPService().generateTOTP(rawSecret);

		const newPassword = randomValidPassword();

		const authAgent = utils.createAuthAgent(app);

		const response = await authAgent(user)
			.patch('/me/password')
			.send({ currentPassword: rawPassword, newPassword, token });

		expect(response.statusCode).toBe(200);
	});

	test('POST /change-password should fail due to missing MFA token', async () => {
		const { user } = await testDb.createUserWithMfaEnabled();

		const newPassword = randomValidPassword();

		const authlessAgent = utils.createAgent(app);

		const oneMinuteFromNow = new Date().getTime() / 1000 + 60;

		const resetPasswordToken = uniqueId();

		await Db.collections.User.update(user.id, {
			resetPasswordToken,
			resetPasswordTokenExpiration: oneMinuteFromNow,
		});

		const response = await authlessAgent
			.post('/change-password')
			.send({ password: newPassword, userId: user.id, token: resetPasswordToken });

		expect(response.statusCode).toBe(400);
	});

	test('POST /change-password should fail due to invalid MFA token', async () => {
		const { user } = await testDb.createUserWithMfaEnabled();

		const newPassword = randomValidPassword();

		const authlessAgent = utils.createAgent(app);

		const oneMinuteFromNow = new Date().getTime() / 1000 + 60;

		const resetPasswordToken = uniqueId();

		await Db.collections.User.update(user.id, {
			resetPasswordToken,
			resetPasswordTokenExpiration: oneMinuteFromNow,
		});

		const response = await authlessAgent.post('/change-password').send({
			password: newPassword,
			userId: user.id,
			token: resetPasswordToken,
			mfaToken: randomDigit(),
		});

		expect(response.statusCode).toBe(400);
	});

	test('POST /change-password should update password', async () => {
		const { user, rawSecret } = await testDb.createUserWithMfaEnabled();

		const newPassword = randomValidPassword();

		const authlessAgent = utils.createAgent(app);

		const oneMinuteFromNow = new Date().getTime() / 1000 + 60;

		const resetPasswordToken = uniqueId();

		const mfaToken = new TOTPService().generateTOTP(rawSecret);

		await Db.collections.User.update(user.id, {
			resetPasswordToken,
			resetPasswordTokenExpiration: oneMinuteFromNow,
		});

		const response = await authlessAgent.post('/change-password').send({
			password: newPassword,
			userId: user.id,
			token: resetPasswordToken,
			mfaToken,
		});

		expect(response.statusCode).toBe(200);

		const authAgent = utils.createAuthAgent(app);

		const loginResponse = await authAgent(user)
			.post('/login')
			.send({
				email: user.email,
				password: newPassword,
				mfaToken: new TOTPService().generateTOTP(rawSecret),
			});

			expect(loginResponse.statusCode).toBe(200);
			expect(loginResponse.body).toHaveProperty('data');

	});
});

describe('Login', () => {
	test('POST /login with email/password should succeed when mfa is disabled', async () => {
		const authlessAgent = utils.createAgent(app);

		const password = randomPassword();

		const user = await testDb.createUser({ password });

		const response = await authlessAgent.post('/login').send({ email: user.email, password });

		expect(response.statusCode).toBe(200);
	});

	test('GET /login should include hasRecoveryCodesLeft property in response', async () => {
		const response = await authAgent(owner).get('/login');

		const { data } = response.body;

		expect(response.statusCode).toBe(200);

		expect(data.hasRecoveryCodesLeft).toBeDefined();
	});

	test('GET /login should not include mfaSecret and mfaRecoveryCodes property in response', async () => {
		const response = await authAgent(owner).get('/login');

		const { data } = response.body;

		expect(response.statusCode).toBe(200);

		expect(data.recoveryCodes).not.toBeDefined();
		expect(data.mfaSecret).not.toBeDefined();
	});

	test('POST /login with email/password should fail when mfa is enabled', async () => {
		const { user, rawPassword } = await testDb.createUserWithMfaEnabled();

		const authlessAgent = utils.createAgent(app);

		const response = await authlessAgent
			.post('/login')
			.send({ email: user.email, password: rawPassword });

		expect(response.statusCode).toBe(401);
		expect(response.body.code).toBe(998);
	});

	describe('Login with MFA token', () => {
		test('POST /login should fail due to invalid MFA token', async () => {
			const { user, rawPassword } = await testDb.createUserWithMfaEnabled();

			const authlessAgent = utils.createAgent(app);

			const response = await authlessAgent
				.post('/login')
				.send({ email: user.email, password: rawPassword, mfaToken: '' });

			expect(response.statusCode).toBe(401);
			expect(response.body.code).toBe(998);
		});

		test('POST /login should succeed with MFA token', async () => {
			const { user, rawSecret, rawPassword } = await testDb.createUserWithMfaEnabled();

			const authlessAgent = utils.createAgent(app);

			const token = new TOTPService().generateTOTP(rawSecret);

			const response = await authlessAgent
				.post('/login')
				.send({ email: user.email, password: rawPassword, mfaToken: token });

			const data = response.body.data;

			expect(response.statusCode).toBe(200);
			expect(data.mfaEnabled).toBe(true);
		});
	});

	describe('Login with recovery code', () => {
		test('POST /login should fail due to invalid MFA recovery code', async () => {
			const { user, rawPassword } = await testDb.createUserWithMfaEnabled();

			const authlessAgent = utils.createAgent(app);

			const response = await authlessAgent
				.post('/login')
				.send({ email: user.email, password: rawPassword, mfaRecoveryCode: '' });

			expect(response.statusCode).toBe(401);
			expect(response.body.code).toBe(998);
		});

		test('POST /login should succeed with MFA recovery code', async () => {
			const { user, rawPassword, rawRecoveryCodes } = await testDb.createUserWithMfaEnabled();

			const authlessAgent = utils.createAgent(app);

			const response = await authlessAgent
				.post('/login')
				.send({ email: user.email, password: rawPassword, mfaRecoveryCode: rawRecoveryCodes[0] });

			const data = response.body.data;

			expect(response.statusCode).toBe(200);
			expect(data.mfaEnabled).toBe(true);
			expect(data.hasRecoveryCodesLeft).toBe(true);

			const dbUser = await Db.collections.User.findOneOrFail({
				where: { id: user.id },
				select: ['mfaEnabled', 'mfaRecoveryCodes', 'mfaSecret'],
			});

			// Make sure the recovery code used was removed
			expect(dbUser.mfaRecoveryCodes.length).toBe(rawRecoveryCodes.length - 1);
			expect(dbUser.mfaRecoveryCodes.includes(rawRecoveryCodes[0])).toBe(false);
		});

		test('POST /login with MFA recovery code should update hasRecoveryCodesLeft property', async () => {
			const { user, rawPassword, rawRecoveryCodes } = await testDb.createUserWithMfaEnabled({
				numberOfRecoveryCodes: 1,
			});

			const authlessAgent = utils.createAgent(app);

			const response = await authlessAgent
				.post('/login')
				.send({ email: user.email, password: rawPassword, mfaRecoveryCode: rawRecoveryCodes[0] });

			const data = response.body.data;

			expect(response.statusCode).toBe(200);
			expect(data.mfaEnabled).toBe(true);
			expect(data.hasRecoveryCodesLeft).toBe(false);
		});
	});
});