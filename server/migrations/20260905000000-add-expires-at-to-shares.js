"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    const columns = await queryInterface.describeTable("shares");
    if (!columns.expiresAt) {
      await queryInterface.addColumn("shares", "expiresAt", {
        type: Sequelize.DATE,
        allowNull: true,
      });
    }

    const indexes = await queryInterface.showIndex("shares");
    if (!indexes.some((index) => index.name === "shares_expires_at")) {
      await queryInterface.addIndex("shares", ["expiresAt"], {
        name: "shares_expires_at",
        where: { expiresAt: { [Sequelize.Op.ne]: null } },
      });
    }

    await queryInterface.sequelize.query(
      'UPDATE "shares" SET "expiresAt" = NOW() + INTERVAL \'1 day\' WHERE "published" = true AND "expiresAt" IS NULL;'
    );
  },

  async down(queryInterface) {
    const indexes = await queryInterface.showIndex("shares");
    if (indexes.some((index) => index.name === "shares_expires_at")) {
      await queryInterface.removeIndex("shares", "shares_expires_at");
    }

    const columns = await queryInterface.describeTable("shares");
    if (columns.expiresAt) {
      await queryInterface.removeColumn("shares", "expiresAt");
    }
  },
};
