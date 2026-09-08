"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("documents", "documentType", {
      type: Sequelize.STRING,
      allowNull: false,
      defaultValue: "document",
    });
    await queryInterface.addColumn("documents", "tableData", {
      type: Sequelize.JSONB,
      allowNull: true,
    });
    await queryInterface.addIndex("documents", ["teamId", "documentType"], {
      name: "documents_team_id_document_type",
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex("documents", "documents_team_id_document_type");
    await queryInterface.removeColumn("documents", "tableData");
    await queryInterface.removeColumn("documents", "documentType");
  },
};
