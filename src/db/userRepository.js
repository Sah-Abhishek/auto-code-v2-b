import { query } from './connection.js';
import bcrypt from 'bcrypt';

export const ROLES = {
  ADMIN: 'admin',
  CODER: 'coder',
  QA: 'qa'
};

export const UserRepository = {

  async create({ userId, password, name, role = 'coder', email = null }) {
    const passwordHash = await bcrypt.hash(password, 10);
    const result = await query(
      `INSERT INTO mc_users (user_id, password_hash, name, role, email)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, user_id, name, role, email, is_active, created_at`,
      [userId, passwordHash, name, role, email]
    );
    return result.rows[0];
  },

  async findByUserId(userId) {
    const result = await query(
      `SELECT * FROM mc_users WHERE user_id = $1`,
      [userId]
    );
    return result.rows[0];
  },

  async findById(id) {
    const result = await query(
      `SELECT * FROM mc_users WHERE id = $1`,
      [id]
    );
    return result.rows[0];
  },

  async verifyPassword(userId, password) {
    const user = await this.findByUserId(userId);
    if (!user) return { valid: false, reason: 'User not found' };
    if (!user.is_active) return { valid: false, reason: 'Account is deactivated' };

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return { valid: false, reason: 'Invalid password' };

    await query(
      `UPDATE mc_users SET last_login = CURRENT_TIMESTAMP WHERE id = $1`,
      [user.id]
    );

    return { valid: true, user };
  },

  async changePassword(userId, newPassword) {
    const passwordHash = await bcrypt.hash(newPassword, 10);
    const result = await query(
      `UPDATE mc_users SET password_hash = $2, updated_at = CURRENT_TIMESTAMP
       WHERE user_id = $1 RETURNING id, user_id, name, role`,
      [userId, passwordHash]
    );
    return result.rows[0];
  },

  async update(userId, { name, email, role, isActive }) {
    const fields = [];
    const params = [userId];
    let idx = 2;

    if (name !== undefined) { fields.push(`name = $${idx}`); params.push(name); idx++; }
    if (email !== undefined) { fields.push(`email = $${idx}`); params.push(email); idx++; }
    if (role !== undefined) { fields.push(`role = $${idx}`); params.push(role); idx++; }
    if (isActive !== undefined) { fields.push(`is_active = $${idx}`); params.push(isActive); idx++; }

    if (fields.length === 0) return this.findByUserId(userId);

    fields.push('updated_at = CURRENT_TIMESTAMP');

    const result = await query(
      `UPDATE mc_users SET ${fields.join(', ')} WHERE user_id = $1 RETURNING *`,
      params
    );
    return result.rows[0];
  },

  async deactivate(userId) {
    const result = await query(
      `UPDATE mc_users SET is_active = FALSE, updated_at = CURRENT_TIMESTAMP
       WHERE user_id = $1 RETURNING *`,
      [userId]
    );
    return result.rows[0];
  },

  async getAll({ role, isActive, search, page = 1, limit = 20 } = {}) {
    const conditions = [];
    const params = [];
    let idx = 1;

    if (role) { conditions.push(`role = $${idx}`); params.push(role); idx++; }
    if (isActive !== undefined) { conditions.push(`is_active = $${idx}`); params.push(isActive); idx++; }
    if (search) { conditions.push(`(user_id ILIKE $${idx} OR name ILIKE $${idx})`); params.push(`%${search}%`); idx++; }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await query(`SELECT COUNT(*) FROM mc_users ${where}`, params);
    const total = parseInt(countResult.rows[0].count);

    const offset = (page - 1) * limit;
    const dataResult = await query(
      `SELECT id, user_id, name, role, email, is_active, last_login, created_at, updated_at
       FROM mc_users ${where}
       ORDER BY created_at DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, limit, offset]
    );

    return {
      users: dataResult.rows,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) }
    };
  },

  async getStats() {
    const result = await query(`
      SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE role = 'admin') as admins,
        COUNT(*) FILTER (WHERE role = 'coder') as coders,
        COUNT(*) FILTER (WHERE role = 'qa') as qa_users,
        COUNT(*) FILTER (WHERE is_active = TRUE) as active,
        COUNT(*) FILTER (WHERE is_active = FALSE) as inactive
      FROM mc_users
    `);
    return result.rows[0];
  },

  async getCoders() {
    const result = await query(
      `SELECT id, user_id, name, email FROM mc_users WHERE role = 'coder' AND is_active = TRUE ORDER BY name`
    );
    return result.rows;
  },

  async getQAUsers() {
    const result = await query(
      `SELECT id, user_id, name, email FROM mc_users WHERE role = 'qa' AND is_active = TRUE ORDER BY name`
    );
    return result.rows;
  }
};

export default UserRepository;
