import express from 'express'
import { authenticateToken } from '../middleware/auth.js'
import { requireSuperAdmin } from '../middleware/rbac.js'
import { getAdminStatsOverview } from '../services/admin-stats-overview.js'

const router = express.Router()

router.use(authenticateToken, requireSuperAdmin)

router.get('/overview', async (req, res) => {
  try {
    const overview = await getAdminStatsOverview()
    res.json(overview)
  } catch (error) {
    console.error('[Admin Stats] overview error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
